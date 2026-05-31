# Slipstream Integration Tests

Comprehensive end-to-end tests for Slipstream on Solana devnet + MagicBlock Ephemeral Rollups.

## Prerequisites

```bash
# Install dependencies
npm install

# Ensure you have a funded devnet wallet
solana-keygen new  # If needed
solana airdrop 5 --url devnet

# Set environment variables (optional)
export PROGRAM_ID=7qujfsb4ZPbQHYVZdqiXq1r8tVAMyyukX94obPqXbVwz
export BASE_RPC=https://api.devnet.solana.com
export ER_RPC=https://devnet.magicblock.app
```

## Test Suites

### 1. Full Flow Test (`full_flow.test.ts`)

End-to-end test covering:
- Initialize global state and market
- Create user accounts
- Deposit USDC collateral
- Delegate order book to Ephemeral Rollup
- Place orders on ER
- Settle trades on L1
- Close positions
- Withdraw collateral
- Undelegate order book

**Run:** `npm test` or `tsx full_flow.test.ts`

### 2. ER Order Book Test (`er_orderbook.test.ts`)

Tests all order book operations on Ephemeral Rollup:
- **LIMIT orders**: Resting orders in the book
- **POST_ONLY orders**: Reject if would cross spread
- **IOC orders**: Immediate-or-cancel with remainder cancellation
- **FOK orders**: Fill-or-kill (all-or-nothing)
- **MARKET orders**: Execute at best available price
- **Cancel operations**: Remove orders from book
- **FIFO matching**: First-in-first-out price-time priority
- **Partial fills**: Orders partially executed
- **Price level management**: Sorted bid/ask levels

**Run:** `npm run test:er`

### 3. Funding Test (`funding.test.ts`)

Tests funding rate mechanics:
- Compute funding rate from mark/index price spread
- Lazy accrual to individual positions
- Cumulative funding index updates
- Long/short payment direction correctness
- 8-hour funding intervals

**Run:** `npm run test:funding`

### 4. Liquidation Test (`liquidation.test.ts`)

Tests liquidation and risk management:
- Health factor computation
- Underwater position detection
- Liquidation bonus calculation (max of 50bps or 20% remaining)
- Insurance fund debit when collateral insufficient
- Circuit breaker triggering on 10% TWAP move

**Run:** `npm run test:liquidation`

## Running All Tests

```bash
npm run test:all
```

## Test Output

Each test logs detailed progress:
- Account initialization confirmations
- Transaction signatures
- State changes (order counts, fills, positions)
- Success/failure indicators with ✓ and ⚠

## Notes

- Tests use **real devnet** and **real MagicBlock ER** - no mocks
- Each test generates fresh keypairs for isolation
- Tests require SOL for transaction fees (airdrops automatically)
- Order book delegation takes ~2-3 seconds to propagate to ER
- Settlement happens via keeper bots (run separately or manually trigger)

## Troubleshooting

**"Order book not delegated"**
- Ensure `delegateAccount()` was called and waited for
- Check delegation status with `isDelegated()`
- Wait 3-5 seconds after delegation before placing orders

**"No fills detected"**
- Orders may not have crossed the spread (check prices)
- Matching happens immediately on ER - check `fillEventCount`
- Settlement to L1 requires running the settlement keeper

**"Transaction simulation failed"**
- Check SOL balance (airdrop if needed)
- Verify program is deployed to devnet
- Ensure all PDAs are correctly derived

## CI Integration

To run in CI:

```bash
# Generate ephemeral keypair
solana-keygen new --no-bip39-passphrase -o /tmp/test-keypair.json

# Fund it
solana airdrop 5 -k /tmp/test-keypair.json --url devnet

# Run tests
KEEPER_KEYPAIR=/tmp/test-keypair.json npm run test:all
```
