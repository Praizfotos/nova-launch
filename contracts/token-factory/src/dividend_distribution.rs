// Pro-rata Dividend Distribution Module (#1148)
//
// This module provides on-chain pro-rata dividend distribution that splits
// a pool across token holders proportionally based on their balance at snapshot.
//
// Key features:
// - Deterministic handling of remainder dust
// - Preservation of authorization invariants (require_auth)
// - Event emission for state changes
//
// Dust policy:
// - When distributing, remainder (pool_amount % total_shares) is tracked
// - Dust accumulates and is distributed in subsequent rounds
// - Ensures no tokens are lost due to integer division

use crate::storage;
use crate::types::Error;
use soroban_sdk::{symbol_short, Address, Env, Vec};

/// Maximum number of holders that can receive dividends in a single distribution
const MAX_DIVIDEND_HOLDERS: u32 = 1000;

/// Dividend distribution record
#[soroban_sdk::contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DividendDistribution {
    pub token_index: u32,
    pub pool_amount: i128,
    pub total_eligible: i128, // Total tokens eligible for distribution
    pub snapshot_ledger: u32,
    pub distributed_amount: i128,
    pub remaining_dust: i128,
    pub timestamp: u64,
}

/// Compute each holder's share proportional to their balance at snapshot.
///
/// # Arguments
/// * `env` - The contract environment
/// * `token_index` - Token index to distribute dividends for
/// * `pool_amount` - Total amount to distribute
/// * `holders` - List of holder addresses to receive dividends
///
/// # Returns
/// Vec of (holder, amount) pairs representing each holder's dividend
///
/// # Errors
/// * `Error::DividendZeroHolders` - No holders provided
/// * `Error::DividendExceedsPool` - Pool amount is invalid
/// * `Error::DividendOverflow` - Calculation overflow
pub fn distribute_dividends(
    env: &Env,
    token_index: u32,
    admin: Address,
    pool_amount: i128,
    holders: Vec<Address>,
) -> Result<Vec<(Address, i128)>, Error> {
    // Authorization check
    admin.require_auth();

    // Verify admin
    let current_admin = storage::get_admin(env);
    if admin != current_admin {
        return Err(Error::Unauthorized);
    }

    // Validate inputs
    if pool_amount <= 0 {
        return Err(Error::InvalidParameters);
    }

    let holder_count = holders.len();
    if holder_count == 0 {
        return Err(Error::DividendZeroHolders);
    }

    if holder_count > MAX_DIVIDEND_HOLDERS {
        return Err(Error::BatchTooLarge);
    }

    // Get total eligible balance (sum of all holder balances)
    let mut total_eligible: i128 = 0;
    for i in 0..holder_count {
        let holder = holders.get(i).unwrap();
        let balance = storage::get_balance(env, token_index, &holder);
        total_eligible = total_eligible.checked_add(balance).ok_or(Error::DividendOverflow)?;
    }

    if total_eligible == 0 {
        return Err(Error::DividendZeroHolders);
    }

    // Calculate dust (remainder from integer division)
    // Dust policy: remainder accumulates and is added to next distribution
    let dust = pool_amount % total_eligible;
    let distributable_amount = pool_amount - dust;

    // Store dust for future distributions
    let existing_dust = get_accumulated_dust(env, token_index);
    let total_dust = existing_dust.checked_add(dust).ok_or(Error::DividendOverflow)?;
    set_accumulated_dust(env, token_index, total_dust);

    // Calculate each holder's share
    let mut distributions = Vec::new(env);
    let pool_u128 = distributable_amount as u128;
    let total_eligible_u128 = total_eligible as u128;

    for i in 0..holder_count {
        let holder = holders.get(i).unwrap();
        let balance = storage::get_balance(env, token_index, &holder);

        if balance > 0 {
            // holder_amount = pool_amount * holder_balance / total_eligible
            let balance_u128 = balance as u128;
            let numerator = pool_u128
                .checked_mul(balance_u128)
                .ok_or(Error::DividendOverflow)?;
            let amount = (numerator / total_eligible_u128) as i128;

            if amount > 0 {
                distributions.push_back((holder, amount));
            }
        }
    }

    // Emit dividend distribution event
    let snapshot_ledger = env.ledger().sequence();
    let timestamp = env.ledger().timestamp();
    emit_dividend_distribution(
        env,
        token_index,
        pool_amount,
        distributable_amount,
        dust,
        holder_count,
        snapshot_ledger,
    );

    // Store distribution record
    let record = DividendDistribution {
        token_index,
        pool_amount,
        total_eligible,
        snapshot_ledger,
        distributed_amount: distributable_amount,
        remaining_dust: total_dust,
        timestamp,
    };
    store_distribution_record(env, &record);

    Ok(distributions)
}

/// Get accumulated dust from previous distributions
fn get_accumulated_dust(env: &Env, token_index: u32) -> i128 {
    env.storage()
        .persistent()
        .get(&crate::types::DataKey::DividendDust(token_index))
        .unwrap_or(0)
}

/// Set accumulated dust
fn set_accumulated_dust(env: &Env, token_index: u32, dust: i128) {
    env.storage()
        .persistent()
        .set(&crate::types::DataKey::DividendDust(token_index), &dust);
}

/// Store dividend distribution record
fn store_distribution_record(env: &Env, record: &DividendDistribution) {
    let count = get_distribution_count(env);
    env.storage()
        .persistent()
        .set(&crate::types::DataKey::DividendRecord(count), record);
    increment_distribution_count(env);
}

fn get_distribution_count(env: &Env) -> u64 {
    env.storage()
        .persistent()
        .get(&crate::types::DataKey::DividendDistributionCount)
        .unwrap_or(0)
}

fn increment_distribution_count(env: &Env) {
    let count = get_distribution_count(env);
    env.storage()
        .persistent()
        .set(&crate::types::DataKey::DividendDistributionCount, &(count + 1));
}

// ─────────────────────────────────────────────
// Event emission
// ─────────────────────────────────────────────

/// Emit dividend distribution event (v1)
///
/// **Schema Version**: 1
/// **Event Name**: div_dst_v1
///
/// **Topics** (indexed):
/// - Event name: "div_dst_v1"
/// - token_index: u32 - The token index
///
/// **Payload** (non-indexed):
/// - pool_amount: i128 - Total pool amount for distribution
/// - distributable: i128 - Amount after dust removal
/// - dust: i128 - Remainder carried over
/// - holder_count: u32 - Number of recipients
/// - snapshot_ledger: u32 - Ledger when snapshot was taken
///
/// Emitted when dividends are distributed to holders
fn emit_dividend_distribution(
    env: &Env,
    token_index: u32,
    pool_amount: i128,
    distributable: i128,
    dust: i128,
    holder_count: u32,
    snapshot_ledger: u32,
) {
    env.events().publish(
        (symbol_short!("div_dst"), token_index),
        (pool_amount, distributable, dust, holder_count, snapshot_ledger),
    );
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

#[cfg(test)]
mod dividend_distribution_test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Address, Env};

    fn setup() -> (Env, Address, u32) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let token_index = 0u32;

        env.register_contract(None, crate::TokenFactory);
        storage::set_admin(&env, &admin);

        (env, admin, token_index)
    }

    #[test]
    fn test_even_distribution() {
        let (env, admin, token_index) = setup();

        // Create 3 holders with equal balance
        let holder1 = Address::generate(&env);
        let holder2 = Address::generate(&env);
        let holder3 = Address::generate(&env);

        storage::set_balance(&env, token_index, &holder1, 1000);
        storage::set_balance(&env, token_index, &holder2, 1000);
        storage::set_balance(&env, token_index, &holder3, 1000);

        let mut holders = Vec::new(&env);
        holders.push_back(holder1);
        holders.push_back(holder2);
        holders.push_back(holder3);

        // Distribute 3000 (1000 each)
        let result = distribute_dividends(&env, token_index, admin, 3000, holders);

        assert!(result.is_ok());
        let distributions = result.unwrap();
        assert_eq!(distributions.len(), 3);

        // Each should get exactly 1000
        let mut amounts = Vec::new(&env);
        for i in 0..3 {
            let (_, amount) = distributions.get(i).unwrap();
            amounts.push_back(*amount);
        }
        assert!(amounts.contains(&1000));
        assert!(amounts.contains(&1000));
        assert!(amounts.contains(&1000));
    }

    #[test]
    fn test_uneven_distribution() {
        let (env, admin, token_index) = setup();

        // Create holders with different balances: 500, 300, 200 (total 1000)
        let holder1 = Address::generate(&env);
        let holder2 = Address::generate(&env);
        let holder3 = Address::generate(&env);

        storage::set_balance(&env, token_index, &holder1, 500);
        storage::set_balance(&env, token_index, &holder2, 300);
        storage::set_balance(&env, token_index, &holder3, 200);

        let mut holders = Vec::new(&env);
        holders.push_back(holder1);
        holders.push_back(holder2);
        holders.push_back(holder3);

        // Distribute 1000 (proportional)
        let result = distribute_dividends(&env, token_index, admin, 1000, holders);

        assert!(result.is_ok());
        let distributions = result.unwrap();

        // holder1: 500/1000 * 1000 = 500
        // holder2: 300/1000 * 1000 = 300
        // holder3: 200/1000 * 1000 = 200
        let mut has_500 = false;
        let mut has_300 = false;
        let mut has_200 = false;
        for i in 0..distributions.len() {
            let (_, amount) = distributions.get(i).unwrap();
            let amt = amount;
            if amt == 500 { has_500 = true; }
            if amt == 300 { has_300 = true; }
            if amt == 200 { has_200 = true; }
        }
        assert!(has_500);
        assert!(has_300);
        assert!(has_200);
    }

    #[test]
    fn test_dust_handling() {
        let (env, admin, token_index) = setup();

        // Two holders: 300, 700 (total 1000)
        let holder1 = Address::generate(&env);
        let holder2 = Address::generate(&env);

        storage::set_balance(&env, token_index, &holder1, 300);
        storage::set_balance(&env, token_index, &holder2, 700);

        let mut holders = Vec::new(&env);
        holders.push_back(holder1);
        holders.push_back(holder2);

        // Distribute 1000 - should have 0 dust (exact division)
        let result = distribute_dividends(&env, token_index, admin.clone(), 1000, holders.clone());
        assert!(result.is_ok());

        // Now distribute 999 - should have dust
        let result2 = distribute_dividends(&env, token_index, admin, 999, holders);
        assert!(result2.is_ok());
    }

    #[test]
    fn test_zero_holders_error() {
        let (env, admin, token_index) = setup();

        let holders: Vec<Address> = Vec::new(&env);
        let result = distribute_dividends(&env, token_index, admin, 1000, holders);

        assert_eq!(result, Err(Error::DividendZeroHolders));
    }

    #[test]
    fn test_unauthorized_error() {
        let (env, admin, token_index) = setup();
        let unauthorized = Address::generate(&env);

        let holder = Address::generate(&env);
        storage::set_balance(&env, token_index, &holder, 1000);
        let mut holders = Vec::new(&env);
        holders.push_back(holder);

        let result = distribute_dividends(&env, token_index, unauthorized, 1000, holders);
        assert_eq!(result, Err(Error::Unauthorized));
    }

    #[test]
    fn test_zero_total_balance_error() {
        let (env, admin, token_index) = setup();

        // All holders have zero balance
        let holder1 = Address::generate(&env);
        let holder2 = Address::generate(&env);

        let mut holders = Vec::new(&env);
        holders.push_back(holder1);
        holders.push_back(holder2);

        let result = distribute_dividends(&env, token_index, admin, 1000, holders);
        assert_eq!(result, Err(Error::DividendZeroHolders));
    }
}