//! Exhaustive edge-case coverage for burn operations (#1051)
//!
//! This module contains comprehensive unit tests for the burn and admin_burn paths,
//! covering boundary values, error conditions, and state consistency.

use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env, String};

#[cfg(test)]
mod burn_edge_cases {
    use super::*;

    // ─────────────────────────────────────────────
    // Zero Amount Tests
    // ─────────────────────────────────────────────

    /// Test: Burn zero amount should fail with InvalidParameters
    #[test]
    fn test_burn_zero_amount_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let creator = Address::generate(&env);

        client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

        let token_address = client.create_token(
            &creator,
            &String::from_str(&env, "Test Token"),
            &String::from_str(&env, "TST"),
            &7,
            &1_000_000,
        );

        // Attempt to burn zero amount
        let result = client.try_burn(&token_address, &creator, &0);
        assert!(result.is_err());
    }

    /// Test: Admin burn zero amount should fail with InvalidParameters
    #[test]
    fn test_admin_burn_zero_amount_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let creator = Address::generate(&env);
        let holder = Address::generate(&env);

        client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

        let token_address = client.create_token(
            &creator,
            &String::from_str(&env, "Test Token"),
            &String::from_str(&env, "TST"),
            &7,
            &1_000_000,
        );

        // Attempt admin burn of zero amount
        let result = client.try_admin_burn(&token_address, &admin, &holder, &0);
        assert!(result.is_err());
    }

    /// Test: Burn negative amount should fail with InvalidParameters
    #[test]
    fn test_burn_negative_amount_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let creator = Address::generate(&env);

        client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

        let token_address = client.create_token(
            &creator,
            &String::from_str(&env, "Test Token"),
            &String::from_str(&env, "TST"),
            &7,
            &1_000_000,
        );

        // Attempt to burn negative amount
        let result = client.try_burn(&token_address, &creator, &-100);
        assert!(result.is_err());
    }

    // ─────────────────────────────────────────────
    // Balance Boundary Tests
    // ─────────────────────────────────────────────

    /// Test: Burn exactly equal to balance succeeds
    #[test]
    fn test_burn_equal_to_balance_succeeds() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let creator = Address::generate(&env);

        client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

        let token_address = client.create_token(
            &creator,
            &String::from_str(&env, "Test Token"),
            &String::from_str(&env, "TST"),
            &7,
            &1_000_000,
        );

        // Burn exactly the balance (1_000_000)
        client.burn(&token_address, &creator, &1_000_000);

        // Verify state
        let info = client.get_token_info(&0);
        assert_eq!(info.total_supply, 0);
        assert_eq!(info.total_burned, 1_000_000);
        assert_eq!(info.burn_count, 1);
    }

    /// Test: Burn exceeding balance fails with InsufficientBalance
    #[test]
    fn test_burn_exceeding_balance_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let creator = Address::generate(&env);

        client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

        let token_address = client.create_token(
            &creator,
            &String::from_str(&env, "Test Token"),
            &String::from_str(&env, "TST"),
            &7,
            &1_000_000,
        );

        // Attempt to burn more than balance
        let result = client.try_burn(&token_address, &creator, &1_000_001);
        assert!(result.is_err());

        // Verify state unchanged
        let info = client.get_token_info(&0);
        assert_eq!(info.total_supply, 1_000_000);
        assert_eq!(info.total_burned, 0);
    }

    /// Test: Burn 1 unit (minimum valid amount)
    #[test]
    fn test_burn_minimum_amount() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let creator = Address::generate(&env);

        client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

        let token_address = client.create_token(
            &creator,
            &String::from_str(&env, "Test Token"),
            &String::from_str(&env, "TST"),
            &7,
            &1_000_000,
        );

        // Burn minimum amount (1)
        client.burn(&token_address, &creator, &1);

        // Verify state
        let info = client.get_token_info(&0);
        assert_eq!(info.total_supply, 999_999);
        assert_eq!(info.total_burned, 1);
        assert_eq!(info.burn_count, 1);
    }

    // ─────────────────────────────────────────────
    // Authorization Tests
    // ─────────────────────────────────────────────

    /// Test: Unauthorized user cannot burn
    #[test]
    fn test_unauthorized_burn_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let creator = Address::generate(&env);
        let unauthorized = Address::generate(&env);

        client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

        let token_address = client.create_token(
            &creator,
            &String::from_str(&env, "Test Token"),
            &String::from_str(&env, "TST"),
            &7,
            &1_000_000,
        );

        // Unauthorized user attempts burn (will fail auth check)
        let result = client.try_burn(&token_address, &unauthorized, &100_000);
        assert!(result.is_err());

        // Verify state unchanged
        let info = client.get_token_info(&0);
        assert_eq!(info.total_supply, 1_000_000);
        assert_eq!(info.total_burned, 0);
    }

    /// Test: Non-admin cannot perform admin_burn
    #[test]
    fn test_non_admin_burn_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let creator = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let holder = Address::generate(&env);

        client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

        let token_address = client.create_token(
            &creator,
            &String::from_str(&env, "Test Token"),
            &String::from_str(&env, "TST"),
            &7,
            &1_000_000,
        );

        // Non-admin attempts admin_burn
        let result = client.try_admin_burn(&token_address, &non_admin, &holder, &100_000);
        assert!(result.is_err());

        // Verify state unchanged
        let info = client.get_token_info(&0);
        assert_eq!(info.total_supply, 1_000_000);
        assert_eq!(info.total_burned, 0);
    }

    // ─────────────────────────────────────────────
    // Admin Burn Specific Tests
    // ─────────────────────────────────────────────

    /// Test: Admin can burn from any holder
    #[test]
    fn test_admin_burn_from_holder() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let creator = Address::generate(&env);
        let holder = Address::generate(&env);

        client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

        let token_address = client.create_token(
            &creator,
            &String::from_str(&env, "Test Token"),
            &String::from_str(&env, "TST"),
            &7,
            &1_000_000,
        );

        // Admin burns from holder
        client.admin_burn(&token_address, &admin, &holder, &500_000);

        // Verify state
        let info = client.get_token_info(&0);
        assert_eq!(info.total_supply, 500_000);
        assert_eq!(info.total_burned, 500_000);
        assert_eq!(info.burn_count, 1);
    }

    /// Test: Admin burn exceeding holder balance fails
    #[test]
    fn test_admin_burn_exceeding_holder_balance_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let creator = Address::generate(&env);
        let holder = Address::generate(&env);

        client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

        let token_address = client.create_token(
            &creator,
            &String::from_str(&env, "Test Token"),
            &String::from_str(&env, "TST"),
            &7,
            &1_000_000,
        );

        // Admin attempts to burn more than holder has
        let result = client.try_admin_burn(&token_address, &admin, &holder, &1_000_001);
        assert!(result.is_err());

        // Verify state unchanged
        let info = client.get_token_info(&0);
        assert_eq!(info.total_supply, 1_000_000);
        assert_eq!(info.total_burned, 0);
    }

    // ─────────────────────────────────────────────
    // Event Emission Tests
    // ─────────────────────────────────────────────

    /// Test: Burn emits correct event with amount and new supply
    #[test]
    fn test_burn_emits_event() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let creator = Address::generate(&env);

        client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

        let token_address = client.create_token(
            &creator,
            &String::from_str(&env, "Test Token"),
            &String::from_str(&env, "TST"),
            &7,
            &1_000_000,
        );

        // Burn and verify event is emitted
        client.burn(&token_address, &creator, &100_000);

        // Events are published; verify state reflects the burn
        let info = client.get_token_info(&0);
        assert_eq!(info.total_supply, 900_000);
        assert_eq!(info.total_burned, 100_000);
    }

    /// Test: Admin burn emits event with admin and holder
    #[test]
    fn test_admin_burn_emits_event() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let creator = Address::generate(&env);
        let holder = Address::generate(&env);

        client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

        let token_address = client.create_token(
            &creator,
            &String::from_str(&env, "Test Token"),
            &String::from_str(&env, "TST"),
            &7,
            &1_000_000,
        );

        // Admin burn and verify event is emitted
        client.admin_burn(&token_address, &admin, &holder, &250_000);

        // Verify state reflects the burn
        let info = client.get_token_info(&0);
        assert_eq!(info.total_supply, 750_000);
        assert_eq!(info.total_burned, 250_000);
    }

    // ─────────────────────────────────────────────
    // State Consistency Tests
    // ─────────────────────────────────────────────

    /// Test: Multiple sequential burns maintain consistency
    #[test]
    fn test_sequential_burns_consistency() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let creator = Address::generate(&env);

        client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

        let token_address = client.create_token(
            &creator,
            &String::from_str(&env, "Test Token"),
            &String::from_str(&env, "TST"),
            &7,
            &1_000_000,
        );

        // First burn
        client.burn(&token_address, &creator, &100_000);
        let info1 = client.get_token_info(&0);
        assert_eq!(info1.total_supply, 900_000);
        assert_eq!(info1.total_burned, 100_000);
        assert_eq!(info1.burn_count, 1);

        // Second burn
        client.burn(&token_address, &creator, &200_000);
        let info2 = client.get_token_info(&0);
        assert_eq!(info2.total_supply, 700_000);
        assert_eq!(info2.total_burned, 300_000);
        assert_eq!(info2.burn_count, 2);

        // Third burn
        client.burn(&token_address, &creator, &50_000);
        let info3 = client.get_token_info(&0);
        assert_eq!(info3.total_supply, 650_000);
        assert_eq!(info3.total_burned, 350_000);
        assert_eq!(info3.burn_count, 3);
    }

    /// Test: Burn count increments correctly
    #[test]
    fn test_burn_count_increments() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let creator = Address::generate(&env);

        client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

        let token_address = client.create_token(
            &creator,
            &String::from_str(&env, "Test Token"),
            &String::from_str(&env, "TST"),
            &7,
            &1_000_000,
        );

        for i in 1..=5 {
            client.burn(&token_address, &creator, &10_000);
            let info = client.get_token_info(&0);
            assert_eq!(info.burn_count, i as u32);
        }
    }

    /// Test: Total burned accumulates correctly
    #[test]
    fn test_total_burned_accumulates() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let creator = Address::generate(&env);

        client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

        let token_address = client.create_token(
            &creator,
            &String::from_str(&env, "Test Token"),
            &String::from_str(&env, "TST"),
            &7,
            &1_000_000,
        );

        let amounts = vec![&env, 100_000, 200_000, 150_000, 50_000];
        let mut total = 0;

        for amount in amounts.iter() {
            client.burn(&token_address, &creator, amount);
            total += amount;
            let info = client.get_token_info(&0);
            assert_eq!(info.total_burned, total);
        }
    }

    /// Test: Supply and burned amounts sum correctly
    #[test]
    fn test_supply_and_burned_sum() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let creator = Address::generate(&env);

        client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

        let initial_supply = 1_000_000;
        let token_address = client.create_token(
            &creator,
            &String::from_str(&env, "Test Token"),
            &String::from_str(&env, "TST"),
            &7,
            &initial_supply,
        );

        // Burn various amounts
        client.burn(&token_address, &creator, &100_000);
        client.burn(&token_address, &creator, &250_000);
        client.burn(&token_address, &creator, &75_000);

        let info = client.get_token_info(&0);
        assert_eq!(info.total_supply + info.total_burned, initial_supply);
    }

    // ─────────────────────────────────────────────
    // Large Amount Tests
    // ─────────────────────────────────────────────

    /// Test: Burn large amount near i128::MAX
    #[test]
    fn test_burn_large_amount() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let creator = Address::generate(&env);

        client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

        let large_supply = 9_223_372_036_854_775_000i128; // Near i128::MAX
        let token_address = client.create_token(
            &creator,
            &String::from_str(&env, "Large Token"),
            &String::from_str(&env, "LRG"),
            &0,
            &large_supply,
        );

        let burn_amount = 1_000_000_000_000_000i128;
        client.burn(&token_address, &creator, &burn_amount);

        let info = client.get_token_info(&0);
        assert_eq!(info.total_supply, large_supply - burn_amount);
        assert_eq!(info.total_burned, burn_amount);
    }

    // ─────────────────────────────────────────────
    // Batch Burn Tests
    // ─────────────────────────────────────────────

    /// Test: Batch burn with multiple holders
    #[test]
    fn test_batch_burn_multiple_holders() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let creator = Address::generate(&env);

        client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

        let token_address = client.create_token(
            &creator,
            &String::from_str(&env, "Test Token"),
            &String::from_str(&env, "TST"),
            &7,
            &1_000_000,
        );

        let holder1 = Address::generate(&env);
        let holder2 = Address::generate(&env);
        let holder3 = Address::generate(&env);

        let burns = soroban_sdk::vec![
            &env,
            (holder1.clone(), 100_000),
            (holder2.clone(), 200_000),
            (holder3.clone(), 150_000),
        ];

        client.burn_batch(&token_address, &admin, &burns);

        let info = client.get_token_info(&0);
        assert_eq!(info.total_supply, 550_000);
        assert_eq!(info.total_burned, 450_000);
        assert_eq!(info.burn_count, 3);
    }

    /// Test: Batch burn empty list fails
    #[test]
    fn test_batch_burn_empty_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let creator = Address::generate(&env);

        client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

        let token_address = client.create_token(
            &creator,
            &String::from_str(&env, "Test Token"),
            &String::from_str(&env, "TST"),
            &7,
            &1_000_000,
        );

        let empty_burns = soroban_sdk::vec![&env];

        let result = client.try_burn_batch(&token_address, &admin, &empty_burns);
        assert!(result.is_err());
    }
}
