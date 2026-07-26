use pinocchio::{
    account_info::AccountInfo,
    instruction::Signer,
    program_error::ProgramError,
    pubkey::Pubkey,
    seeds,
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;

use crate::error::SlipstreamError;
use crate::math::fixed_point::{
    apply_bps, compute_health_factor, compute_initial_margin,
    compute_maintenance_margin, compute_notional, compute_unrealized_pnl,
};
use crate::math::funding::compute_funding_payment;
use crate::oracle::apply_dual_oracle;
use crate::state::{
    LiquidationIntent, Market, Position, UserAccount,
    DISC_LIQUIDATION_INTENT, SEED_LIQ_INTENT, SEED_MARKET,
};

// liquidate_position instruction data: empty (oracle prices come from accounts)

/// Health factor threshold for liquidation (1.0 in 6-decimal fixed point).
const HEALTH_FACTOR_LIQUIDATION_THRESHOLD: u64 = 1_000_000;

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    // Accounts:
    //   [0] market               (W)
    //   [1] position             (W)
    //   [2] user_account         (W) — position owner's account
    //   [3] pyth_feed            (R)
    //   [4] switchboard_feed     (R)
    //   [5] liquidation_intent   (W) — PDA, may be uninitialized
    //   [6] liquidator           (signer, payer for intent creation)
    //   [7] system_program       (R) — for intent creation
    let [
        market_acc,
        position_acc,
        user_account_acc,
        pyth_feed_acc,
        switchboard_feed_acc,
        liquidation_intent_acc,
        liquidator,
        system_program,
        _remaining @ ..
    ] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !liquidator.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // Pin market_acc's identity before trusting anything it holds (mark price,
    // leverage, funding index, OI) — this instruction settles PnL/funding/OI and
    // pays a liquidator bounty straight from it.
    if market_acc.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    {
        let market_check = Market::from_account_info(market_acc)?;
        let (market_pda, _) = pinocchio::pubkey::find_program_address(
            &[SEED_MARKET, &market_check.market_index.to_le_bytes()],
            program_id,
        );
        if market_acc.key() != &market_pda {
            return Err(SlipstreamError::InvalidPda.into());
        }
    }

    // --- Pause / circuit breaker gates ---
    {
        let market = Market::from_account_info(market_acc)?;
        if market.circuit_breaker_active != 0 {
            return Err(SlipstreamError::MarketPaused.into());
        }
    }

    // --- Dual-oracle read (with hysteresis) ---
    // apply_dual_oracle mutates `restricted_mode` + `agreement_streak` in place.
    let mark_price = {
        let market = Market::from_account_info_mut(market_acc)?;
        apply_dual_oracle(market, pyth_feed_acc, switchboard_feed_acc, now)?
    };

    // --- Load position + verify ownership ---
    let pos = Position::from_account_info(position_acc)?;
    if pos.is_empty() {
        return Err(SlipstreamError::PositionNotFound.into());
    }
    let user = UserAccount::from_account_info(user_account_acc)?;
    if pos.owner != user.owner {
        return Err(SlipstreamError::InvalidAuthority.into());
    }

    // Bind the position to THIS market — every economic decision below (mark
    // price, leverage, funding index, OI) comes from market_acc, whose identity
    // is pinned at the top of this function. Without this, a position on market A
    // could be liquidated against market B's parameters (latent while only one
    // market is deployed, live the moment a second exists).
    {
        let market_check = Market::from_account_info(market_acc)?;
        if pos.market_index != market_check.market_index {
            return Err(SlipstreamError::InvalidMarketIndex.into());
        }
    }

    // --- Compute health factor ---
    let (max_leverage, cumulative_funding) = {
        let market_view = Market::from_account_info(market_acc)?;
        (market_view.max_leverage, market_view.get_cumulative_funding_index())
    };

    let abs_size = pos.abs_size();
    let notional = compute_notional(abs_size, mark_price)?;
    let initial_margin = compute_initial_margin(notional, max_leverage)?;
    let maintenance_margin = compute_maintenance_margin(initial_margin);

    let unrealized_pnl = compute_unrealized_pnl(pos.size, pos.entry_price, mark_price)?;
    // Positive funding_payment means the position PAYS (see math/funding.rs).
    let funding_payment = compute_funding_payment(
        pos.size,
        cumulative_funding,
        pos.get_funding_index_snapshot(),
        mark_price,
    )?;

    // compute_health_factor's `accrued_funding` is ADDED to margin, i.e. it wants
    // "funding owed TO the position" — the negation of a payment the position
    // owes. Passing funding_payment directly (as before) meant a position that
    // owed a LARGE funding debt reported a HIGHER health factor, protecting it
    // from liquidation exactly when it was least solvent.
    let health = compute_health_factor(
        pos.collateral,
        unrealized_pnl,
        -funding_payment,
        maintenance_margin,
    )?;

    if health >= HEALTH_FACTOR_LIQUIDATION_THRESHOLD {
        // Position recovered — if we previously wrote a LiquidationIntent, clear it.
        if !liquidation_intent_acc.data_is_empty() {
            close_liquidation_intent(program_id, liquidation_intent_acc, position_acc, liquidator)?;
        }
        return Err(SlipstreamError::HealthFactorAboveThreshold.into());
    }

    // --- Pending fills grace window (§11) ---
    if user.pending_fills > 0 {
        // Create the intent and return (not liquidatable THIS call), or proceed
        // if a previously-created intent has expired.
        let ready = handle_grace_window(
            program_id,
            liquidation_intent_acc,
            position_acc,
            liquidator,
            system_program,
            now,
            health,
        )?;
        if !ready {
            return Ok(());
        }
        // Grace period expired — fall through and liquidate in this same call.
    }

    // If we get here, either pending_fills == 0, OR the grace window expired and
    // we fell through above. Either way, proceed.

    // --- Compute liquidator bonus: 50bps of notional, capped at 20% of the
    // position's remaining net collateral, per §16.
    let bonus_bps = apply_bps(notional, 50)?;
    let net_collateral = (pos.collateral as i128 + unrealized_pnl as i128 - funding_payment as i128)
        .max(0) as u64;
    let bonus_pct = net_collateral / 5; // 20%
    let liquidator_bonus = bonus_bps.min(bonus_pct);

    // --- Settle the position ---
    let market_mut = Market::from_account_info_mut(market_acc)?;
    if pos.is_long() {
        market_mut.open_interest_long = market_mut.open_interest_long.saturating_sub(abs_size);
    } else {
        market_mut.open_interest_short = market_mut.open_interest_short.saturating_sub(abs_size);
    }

    let total_settlement = (pos.collateral as i128)
        + (unrealized_pnl as i128)
        - (funding_payment as i128)
        - (liquidator_bonus as i128);

    let pos_mut = Position::from_account_info_mut(position_acc)?;
    pos_mut.size = 0;
    pos_mut.entry_price = 0;
    pos_mut.collateral = 0;
    pos_mut.realized_pnl = pos_mut
        .realized_pnl
        .saturating_add(unrealized_pnl)
        .saturating_sub(funding_payment);
    pos_mut.set_funding_index_snapshot(cumulative_funding);

    let user_mut = UserAccount::from_account_info_mut(user_account_acc)?;
    if total_settlement > 0 {
        user_mut.free_collateral = user_mut
            .free_collateral
            .checked_add(total_settlement as u64)
            .ok_or(ProgramError::from(SlipstreamError::MathOverflow))?;
    } else {
        let deficit = (-total_settlement) as u64;
        let market_mut = Market::from_account_info_mut(market_acc)?;
        if market_mut.insurance_fund_balance >= deficit {
            market_mut.insurance_fund_balance -= deficit;
        } else {
            // Documented gap: ADL would trigger here in full implementation. For MVP,
            // drain the insurance fund and absorb the rest as protocol bad debt.
            market_mut.insurance_fund_balance = 0;
        }
    }

    // Successful liquidation — clean up any leftover intent
    if !liquidation_intent_acc.data_is_empty() {
        close_liquidation_intent(program_id, liquidation_intent_acc, position_acc, liquidator)?;
    }

    Ok(())
}

/// Handle the 60-second grace window when the position has pending fills.
/// Returns `Ok(true)` when the caller should proceed to liquidate NOW (a
/// previously-created intent has expired), `Ok(false)` when there is nothing
/// further to do this call (either a fresh intent was just created, or an
/// existing one hasn't expired yet).
///
/// Both `Ok(false)` cases MUST be actual successes, not `Err`: the intent-
/// creation branch's `CreateAccount` CPI only persists if this instruction
/// commits, and the previous version returned `Err(GracePeriodActive)` from
/// that exact branch — rolling the just-created account back out of existence
/// on every single call, so the grace window could never even start and every
/// liquidation attempt against an account with pending_fills > 0 failed
/// identically forever, regardless of how insolvent it became.
fn handle_grace_window(
    program_id: &Pubkey,
    intent_acc: &AccountInfo,
    position_acc: &AccountInfo,
    liquidator: &AccountInfo,
    system_program: &AccountInfo,
    now: i64,
    health: u64,
) -> Result<bool, ProgramError> {
    let (expected_pda, bump) = pinocchio::pubkey::find_program_address(
        &[SEED_LIQ_INTENT, position_acc.key().as_ref()],
        program_id,
    );
    if intent_acc.key() != &expected_pda {
        return Err(SlipstreamError::InvalidPda.into());
    }

    if intent_acc.data_is_empty() {
        // Create the intent. Not ready to liquidate this call, but this branch
        // must return Ok so the account creation actually commits.
        if system_program.key() != &pinocchio_system::ID {
            return Err(ProgramError::IncorrectProgramId);
        }
        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(LiquidationIntent::LEN);
        let bump_bytes = [bump];
        let signer_seeds = seeds![SEED_LIQ_INTENT, position_acc.key().as_ref(), &bump_bytes];

        CreateAccount {
            from: liquidator,
            to: intent_acc,
            lamports,
            space: LiquidationIntent::LEN as u64,
            owner: program_id,
        }
        .invoke_signed(&[Signer::from(&signer_seeds)])?;

        let intent = LiquidationIntent::from_account_info_mut_or_init(intent_acc)?;
        intent.discriminator = DISC_LIQUIDATION_INTENT;
        intent.bump = bump;
        intent._padding = [0u8; 6];
        intent.position = *position_acc.key();
        intent.created_ts = now;
        intent.deadline_ts = now + LiquidationIntent::GRACE_WINDOW_SECS;
        intent.initial_health_factor = health;

        return Ok(false);
    }

    // Intent exists — check if expired
    let intent = LiquidationIntent::from_account_info(intent_acc)?;
    if intent.position != *position_acc.key() {
        return Err(SlipstreamError::InvalidPda.into());
    }
    if !intent.is_expired(now) {
        return Ok(false); // still waiting
    }
    // Expired — caller proceeds with liquidation now, in this same call.
    Ok(true)
}

/// Reclaim rent for a `LiquidationIntent` PDA by transferring its lamports to the
/// liquidator. Pinocchio doesn't expose `close_account` directly, so we zero the
/// data and move lamports manually.
///
/// Both call sites previously passed `intent_acc` straight through with NO
/// validation whatsoever — no owner check, no discriminator check (so no
/// `LiquidationIntent::from_account_info` load), no PDA re-derivation, and no
/// check that it belonged to THIS position. Any program-owned account (an
/// unrelated GlobalState, Market, or any third party's UserAccount/Position —
/// the runtime's not-owned-write check is the only thing that limited the
/// blast radius) could be zeroed and its rent lamports stolen on an otherwise
/// completely ordinary, successful liquidation call. A LiquidationIntent can
/// only ever be created by the CreateAccount CPI in `handle_grace_window`
/// above, which is itself seeds-bound to `[SEED_LIQ_INTENT, position]` — so an
/// owner + discriminator + position-match check is equivalent to re-deriving
/// the PDA (no separate account could exist with those three properties true).
fn close_liquidation_intent(
    program_id: &Pubkey,
    intent_acc: &AccountInfo,
    position_acc: &AccountInfo,
    liquidator: &AccountInfo,
) -> ProgramResult {
    if intent_acc.owner() != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    let intent = LiquidationIntent::from_account_info(intent_acc)?;
    if intent.position != *position_acc.key() {
        return Err(SlipstreamError::InvalidPda.into());
    }

    // Zero the data so the discriminator is invalidated
    let data = unsafe { intent_acc.borrow_mut_data_unchecked() };
    for b in data.iter_mut() {
        *b = 0;
    }
    // Move lamports to liquidator
    let lamports = unsafe { *intent_acc.borrow_lamports_unchecked() };
    unsafe {
        *intent_acc.borrow_mut_lamports_unchecked() = 0;
        *liquidator.borrow_mut_lamports_unchecked() += lamports;
    }
    Ok(())
}
