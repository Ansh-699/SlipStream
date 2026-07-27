// Unit test crate for slipstream program.
// Math tests are in the main crate (programs/slipstream/src/math/*.rs)
// State tests verify serialization and bytemuck layouts
// Order book tests verify data structure operations
// Full instruction tests are in integration tests (tests/integration/)

#[cfg(test)]
mod test_state;

#[cfg(test)]
mod test_order_book;

#[cfg(test)]
mod test_instructions_simple;

#[cfg(test)]
mod test_trading_credit;

// Mollusk (in-process SVM) tests running the real compiled program.
#[cfg(test)]
mod test_close_position;

// Negative tests pinning the account-validation fixes.
#[cfg(test)]
mod test_security_regressions;

// Negative tests pinning the place_order fixes (forged Market, reduce_only bypass).
#[cfg(test)]
mod test_place_order_regressions;

// Regression tests for update_position's reduce/flatten collateral accounting.
#[cfg(test)]
mod test_settle_trades_regressions;

// Regression test proving the funding sign fix (a long must pay, not be paid,
// when the funding index rises).
#[cfg(test)]
mod test_funding_sign_regressions;

// Regression tests for record_pending_fill's new authority requirement.
#[cfg(test)]
mod test_record_pending_fill_regressions;

// Regression test for liquidate_position's LiquidationIntent validation fix.
#[cfg(test)]
mod test_liquidate_position_regressions;

// Regression tests for close_user_account's open-position gate.
#[cfg(test)]
mod test_close_user_account_regressions;

// Tests for the two-step GlobalState.authority rotation.
#[cfg(test)]
mod test_authority_rotation;

// Tests for the newly-wired global pause switch.
#[cfg(test)]
mod test_global_pause;

// Regression tests for the FillLog overrun fix (mirror_fills / FillLogView::push).
#[cfg(test)]
mod test_mirror_fills_regressions;

// Regression test for the dual-oracle restricted_mode persistence fix.
#[cfg(test)]
mod test_oracle_restricted_mode_regressions;

// Regression tests for withdraw_collateral's vault-pin and mandatory
// same-slot-guard fixes.
#[cfg(test)]
mod test_withdraw_collateral_regressions;

// Regression tests for cancel_order's permissionless-expiry-cancel fix.
#[cfg(test)]
mod test_cancel_order_expiry_regressions;

// Regression test for initialize_market's fee/rebate bound check.
#[cfg(test)]
mod test_initialize_market_regressions;

// Regression test for compute_funding's interval-scaling fix.
#[cfg(test)]
mod test_compute_funding_regressions;
