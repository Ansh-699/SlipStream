use pinocchio::{
    account_info::AccountInfo,
    instruction::Signer,
    program_error::ProgramError,
    pubkey::Pubkey,
    seeds,
    sysvars::{rent::Rent, Sysvar},
    ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;

use crate::error::SlipstreamError;
use crate::state::{UserAccount, DISC_USER_ACCOUNT, SEED_USER};

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    let [user_account_acc, owner, system_program, _remaining @ ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !owner.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if system_program.key() != &pinocchio_system::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    let (user_pda, bump) = pinocchio::pubkey::find_program_address(
        &[SEED_USER, owner.key().as_ref()],
        program_id,
    );
    if user_account_acc.key() != &user_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }

    if !user_account_acc.data_is_empty() {
        return Err(SlipstreamError::AccountAlreadyInitialized.into());
    }

    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(UserAccount::LEN);
    let bump_bytes = [bump];
    let signer_seeds = seeds![SEED_USER, owner.key().as_ref(), &bump_bytes];

    CreateAccount {
        from: owner,
        to: user_account_acc,
        lamports,
        space: UserAccount::LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[Signer::from(&signer_seeds)])?;

    let user = UserAccount::from_account_info_mut_or_init(user_account_acc)?;
    user.discriminator = DISC_USER_ACCOUNT;
    user.bump = bump;
    user.pending_fills = 0;
    user.owner = *owner.key();
    user.free_collateral = 0;
    user.reserved_margin = 0;

    Ok(())
}
