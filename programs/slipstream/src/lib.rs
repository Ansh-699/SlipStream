pub mod error;
pub mod instructions;
pub mod math;
pub mod oracle;
pub mod state;

#[cfg(not(feature = "no-entrypoint"))]
mod entrypoint {
    use pinocchio::{account_info::AccountInfo, entrypoint, pubkey::Pubkey, ProgramResult};

    entrypoint!(process_instruction);

    pub fn process_instruction(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        instruction_data: &[u8],
    ) -> ProgramResult {
        crate::instructions::process(program_id, accounts, instruction_data)
    }
}

pinocchio_pubkey::declare_id!("7qujfsb4ZPbQHYVZdqiXq1r8tVAMyyukX94obPqXbVwz");
