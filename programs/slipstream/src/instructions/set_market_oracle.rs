use pinocchio::{
    account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey, ProgramResult,
};

use crate::error::SlipstreamError;
use crate::state::{GlobalState, Market, SEED_MARKET};

/// set_market_oracle (disc 0x25): admin-only update of a market's recorded oracle
/// feed pubkeys.
///
/// WHY THIS EXISTS: `initialize_market` was the only writer of `Market.pyth_feed` /
/// `Market.switchboard_feed`, and nothing ever read them — so when the operational
/// Pyth feed was migrated (legacy V2 aggregate -> Receiver PriceUpdateV2) the
/// recorded value was left pointing at an account that has since gone ~700 days
/// stale. Once the oracle-identity check landed, every price-consuming instruction
/// correctly refused to run. Rotating a feed is a legitimate lifecycle operation and
/// needs a first-class, authority-gated instruction rather than a market re-init.
///
/// Accounts:
///   [0] global_state (R)      — authority source of truth
///   [1] market       (W)
///   [2] authority    (signer) — must equal GlobalState.authority
///
/// Instruction data (64 bytes):
///   pyth_feed:        [u8; 32]
///   switchboard_feed: [u8; 32]
const IX_DATA_LEN: usize = 32 + 32;

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let [global_state_acc, market_acc, authority, _remaining @ ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if data.len() < IX_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }

    if global_state_acc.owner() != program_id || market_acc.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }

    {
        let global = GlobalState::from_account_info(global_state_acc)?;
        if global.authority != *authority.key() {
            return Err(SlipstreamError::InvalidAuthority.into());
        }
    }

    // Pin the market to its canonical PDA so the authority cannot be tricked into
    // stamping a look-alike account.
    let market_index = Market::from_account_info(market_acc)?.market_index;
    let (market_pda, _) = pinocchio::pubkey::find_program_address(
        &[SEED_MARKET, &market_index.to_le_bytes()],
        program_id,
    );
    if market_acc.key() != &market_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }

    let mut pyth = [0u8; 32];
    pyth.copy_from_slice(&data[..32]);
    let mut switchboard = [0u8; 32];
    switchboard.copy_from_slice(&data[32..64]);

    let market = Market::from_account_info_mut(market_acc)?;
    market.pyth_feed = pyth;
    market.switchboard_feed = switchboard;

    Ok(())
}
