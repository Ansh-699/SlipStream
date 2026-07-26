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
