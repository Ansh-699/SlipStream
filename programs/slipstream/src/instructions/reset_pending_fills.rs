use pinocchio::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey, ProgramResult};

/// reset_pending_fills (disc 0x29) — PRE-LANDED STUB, run `remediate` slice R5.
///
/// The dispatch arm, discriminator and module declaration are pre-landed by the
/// orchestrator because `instructions/mod.rs` cannot be split across seven
/// parallel slices. The body is this slice's work. Until it lands the
/// instruction is inert and refuses every call, so the stub can never widen the
/// program's authority surface.
pub fn process(
    _program_id: &Pubkey,
    _accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    Err(ProgramError::InvalidInstructionData)
}
