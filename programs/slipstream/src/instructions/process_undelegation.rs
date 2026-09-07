//! MagicBlock's owner-program undelegation callback.
//!
//! NEEDS-DEPLOY. The delegation program (`DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`)
//! cannot hand a data-bearing account back to its owner directly — the runtime
//! only lets an owner change when the data is all-zero. So its `undelegate`
//! copies the committed bytes into an "undelegate buffer" PDA of its own, CLOSES
//! the delegated account, and CPIs the OWNER program with
//! `EXTERNAL_UNDELEGATE_DISCRIMINATOR ++ borsh(Vec<Vec<u8>> seeds)`, expecting the
//! owner to re-create the PDA and copy the buffer back in. It then asserts
//! `delegated.data == buffer.data` (`InvalidAccountDataAfterCPI`) and that the
//! payer lost exactly `rent(data_len)`.
//!
//! Slipstream had no handler for that discriminator: `instructions::process`
//! `split_first()`s a ONE-byte discriminator and matches `0x00..=0x2A`, so byte
//! 196 fell through to `_ => Err(InvalidInstructionData)`, the CPI reverted, the
//! whole `undelegate` transaction aborted, and the account stayed owned by the
//! delegation program forever. Ten TradingCredit PDAs are stranded that way on
//! devnet today (all ten carry a failed validator `undelegate` tx); no credit has
//! ever come back. This module is the missing handler.
//!
//! Mirrors `ephemeral-rollups-sdk` `cpi::undelegate_account`.

use pinocchio::{
    account_info::AccountInfo,
    instruction::{Seed, Signer},
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvars::{rent::Rent, Sysvar},
    ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;

use crate::error::SlipstreamError;
use crate::instructions::delegate_trading_credit::DELEGATION_PROGRAM_ID;

/// `dlp_api::consts::EXTERNAL_UNDELEGATE_DISCRIMINATOR`. Stable across dlp
/// v1.0.0 and main. 0xC4 is outside this program's `0x00..=0x2A` one-byte
/// discriminator space, so routing on it collides with nothing.
pub const EXTERNAL_UNDELEGATE_DISCRIMINATOR: [u8; 8] = [196, 28, 41, 206, 48, 37, 51, 167];

/// `dlp_api::pda::UNDELEGATE_BUFFER_TAG`.
///
/// NOT the same PDA as `state::SEED_DELEGATE_BUFFER` (`b"buffer"`, derived under
/// THIS program) that `delegate_trading_credit` stages delegation through: the
/// UNdelegate buffer is derived under the DELEGATION program, which is what lets
/// the delegation program sign for it on this CPI.
const UNDELEGATE_BUFFER_TAG: &[u8] = b"undelegate-buffer";

/// Upper bound on PDA seeds rebuilt from the callback payload. The delegation
/// record replays whatever seeds `delegate_*` registered; the longest this
/// program registers is 3 (`[b"credit", owner, market_index]`). 8 leaves headroom
/// and keeps the parse allocation-free.
const MAX_SEEDS: usize = 8;

const EMPTY: &[u8] = &[];

/// Accounts (fixed by `dlp::cpi_external_undelegate`):
///   [0] delegated_account (writable)         — the PDA being handed back
///   [1] undelegate_buffer (writable, signer) — delegation-program PDA holding the bytes
///   [2] payer             (writable, signer) — the validator; funds the new rent
///   [3] system_program    (read)
///
/// `data` is the instruction payload with the 8-byte discriminator already
/// stripped: borsh `Vec<Vec<u8>>` of the delegated account's PDA seeds (no bump).
pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let [delegated_acc, buffer_acc, payer, system_program, _remaining @ ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !payer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if system_program.key() != &pinocchio_system::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Authenticating the caller: a CPI cannot see who invoked it, but only the
    // delegation program can produce a signature for a PDA derived under the
    // delegation program. Buffer-is-signer + buffer-is-that-address together are
    // that proof, and they are the same two checks the SDK helper makes.
    if !buffer_acc.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let (buffer_pda, _) = pinocchio::pubkey::find_program_address(
        &[UNDELEGATE_BUFFER_TAG, delegated_acc.key().as_ref()],
        &DELEGATION_PROGRAM_ID,
    );
    if buffer_acc.key() != &buffer_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }

    // Re-derive the delegated account from the replayed seeds under THIS program.
    // This is what confines the handler to accounts we actually own: an address
    // that does not derive from the supplied seeds is refused, so the callback can
    // never be steered at a third party's account.
    let mut seed_bytes: [&[u8]; MAX_SEEDS] = [EMPTY; MAX_SEEDS];
    let seed_count = parse_seeds(data, &mut seed_bytes)?;
    let (expected_pda, bump) =
        pinocchio::pubkey::find_program_address(&seed_bytes[..seed_count], program_id);
    if delegated_acc.key() != &expected_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }

    // Size comes from the buffer, so this serves the 96-byte TradingCredit and the
    // four legacy 56-byte ones identically.
    //
    // ponytail: CEILING — this cannot serve the ~626 KB OrderBook. A CPI may only
    // grow an account by `MAX_PERMITTED_DATA_INCREASE` (10,240 bytes), so the
    // `CreateAccount` below caps out ~61x short, and the delegation program would
    // have to stage 626 KB into a buffer first. That is the same cap that forced
    // `delegate_orderbook_prepare`'s chunked staging on the way IN, and there is
    // no chunked way OUT: the delegation program's callback is a single CPI.
    // The book is delegated once, at deploy, forever
    // (docs/03-ephemeral-rollups-and-delegation.md §3.4). No upgrade path here;
    // the OrderBook's exit is re-initialization, not undelegation.
    let space = buffer_acc.data_len();

    let bump_seed = [bump];
    let mut signer_seeds: [Seed; MAX_SEEDS + 1] = core::array::from_fn(|_| Seed::from(EMPTY));
    for (slot, bytes) in signer_seeds.iter_mut().zip(seed_bytes[..seed_count].iter()) {
        *slot = Seed::from(*bytes);
    }
    signer_seeds[seed_count] = Seed::from(&bump_seed[..]);

    CreateAccount {
        from: payer,
        to: delegated_acc,
        // EXACTLY the rent minimum: the delegation program asserts the payer lost
        // precisely `rent(data_len)` across this CPI and otherwise aborts with
        // `InvalidValidatorBalanceAfterCPI`. Overpaying fails as hard as underpaying.
        lamports: Rent::get()?.minimum_balance(space),
        space: space as u64,
        owner: program_id,
    }
    .invoke_signed(&[Signer::from(&signer_seeds[..seed_count + 1])])?;

    // Byte-for-byte, or the delegation program aborts with InvalidAccountDataAfterCPI.
    let src = unsafe { buffer_acc.borrow_data_unchecked() };
    let dst = unsafe { delegated_acc.borrow_mut_data_unchecked() };
    dst.copy_from_slice(src);

    Ok(())
}

/// Borsh `Vec<Vec<u8>>`: u32 LE count, then per element u32 LE length + bytes.
/// Borrows straight out of the instruction data — no allocator, no copies.
fn parse_seeds<'a>(
    data: &'a [u8],
    out: &mut [&'a [u8]; MAX_SEEDS],
) -> Result<usize, ProgramError> {
    let count = u32::from_le_bytes(
        data.get(..4)
            .ok_or(ProgramError::InvalidInstructionData)?
            .try_into()
            .unwrap(),
    ) as usize;
    if count == 0 || count > MAX_SEEDS {
        return Err(ProgramError::InvalidInstructionData);
    }

    let mut offset = 4usize;
    for slot in out.iter_mut().take(count) {
        let len = u32::from_le_bytes(
            data.get(offset..offset + 4)
                .ok_or(ProgramError::InvalidInstructionData)?
                .try_into()
                .unwrap(),
        ) as usize;
        offset += 4;
        *slot = data
            .get(offset..offset + len)
            .ok_or(ProgramError::InvalidInstructionData)?;
        offset += len;
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact payload the live failed undelegate carried (audit evidence):
    /// 3 seeds = [b"credit", owner(32), market_index(2)].
    #[test]
    fn test_parse_seeds_matches_live_credit_payload() {
        let mut data = Vec::new();
        data.extend_from_slice(&3u32.to_le_bytes());
        data.extend_from_slice(&6u32.to_le_bytes());
        data.extend_from_slice(b"credit");
        data.extend_from_slice(&32u32.to_le_bytes());
        data.extend_from_slice(&[7u8; 32]);
        data.extend_from_slice(&2u32.to_le_bytes());
        data.extend_from_slice(&2u16.to_le_bytes());

        let mut out: [&[u8]; MAX_SEEDS] = [EMPTY; MAX_SEEDS];
        let n = parse_seeds(&data, &mut out).unwrap();
        assert_eq!(n, 3);
        assert_eq!(out[0], b"credit");
        assert_eq!(out[1], &[7u8; 32]);
        assert_eq!(out[2], &2u16.to_le_bytes());
    }

    #[test]
    fn test_parse_seeds_rejects_truncated_and_absurd_payloads() {
        let mut out: [&[u8]; MAX_SEEDS] = [EMPTY; MAX_SEEDS];
        // No count at all.
        assert!(parse_seeds(&[], &mut out).is_err());
        // Count claims one seed; no length follows.
        let one = 1u32.to_le_bytes();
        assert!(parse_seeds(&one, &mut out).is_err());
        // Length runs past the end of the payload.
        let mut short = Vec::new();
        short.extend_from_slice(&1u32.to_le_bytes());
        short.extend_from_slice(&99u32.to_le_bytes());
        short.extend_from_slice(b"nope");
        assert!(parse_seeds(&short, &mut out).is_err());
        // More seeds than a PDA can carry through our fixed buffer.
        let too_many = (MAX_SEEDS as u32 + 1).to_le_bytes();
        assert!(parse_seeds(&too_many, &mut out).is_err());
        // Zero seeds would derive an address we never registered.
        let none = 0u32.to_le_bytes();
        assert!(parse_seeds(&none, &mut out).is_err());
    }
}
