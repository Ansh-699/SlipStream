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
