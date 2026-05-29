//! Batch Operation Atomicity Tests
//!
//! Verifies that batch operations maintain all-or-nothing semantics:
//! - Invalid element mid-batch causes entire batch to revert
//! - Valid batch applies all elements atomically
//! - Empty and single-element batches handled correctly
//! - State before/after failed batch is identical

#[cfg(test)]
mod tests {
    use crate::batch_operations::{batch_reveal, MAX_BATCH_SIZE};
    use crate::storage;
    use crate::types::{Error, TokenCreationParams};
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::{Address, Env, String as SorobanString, Vec};

    fn setup_env() -> (Env, Address) {
        let env = Env::default();
        env.ledger().set_timestamp(1000);
        let admin = Address::random(&env);
        let treasury = Address::random(&env);

        // Initialize factory
        crate::lib::initialize(
            &env,
            admin.clone(),
            treasury,
            70_000_000,
            30_000_000,
        )
        .unwrap();

        (env, admin)
    }

    fn create_token_params(env: &Env, name: &str, symbol: &str) -> TokenCreationParams {
        TokenCreationParams {
            name: SorobanString::from_slice(env, name.as_bytes()),
            symbol: SorobanString::from_slice(env, symbol.as_bytes()),
            decimals: 7,
            initial_supply: 1_000_000_000_000,
            metadata_uri: None,
        }
    }

    fn create_token_params_with_metadata(
        env: &Env,
        name: &str,
        symbol: &str,
    ) -> TokenCreationParams {
        TokenCreationParams {
            name: SorobanString::from_slice(env, name.as_bytes()),
            symbol: SorobanString::from_slice(env, symbol.as_bytes()),
            decimals: 7,
            initial_supply: 1_000_000_000_000,
            metadata_uri: Some(SorobanString::from_slice(env, "ipfs://QmTest")),
        }
    }

    #[test]
    fn test_batch_atomicity_invalid_element_mid_batch() {
        let (env, creator) = setup_env();

        // Get initial token count
        let initial_count = storage::get_token_count(&env);

        // Create batch with invalid element in the middle
        let mut tokens = Vec::new(&env);
        tokens.push_back(create_token_params(&env, "Token1", "T1"));
        tokens.push_back(TokenCreationParams {
            name: SorobanString::from_slice(&env, ""),  // Invalid: empty name
            symbol: SorobanString::from_slice(&env, "INVALID"),
            decimals: 7,
            initial_supply: 1_000_000_000_000,
            metadata_uri: None,
        });
        tokens.push_back(create_token_params(&env, "Token3", "T3"));

        // Calculate required fee
        let base_fee = storage::get_base_fee(&env);
        let required_fee = base_fee * 3;

        // Attempt batch - should fail
        let result = batch_reveal(&env, creator.clone(), tokens, required_fee);
        assert!(result.is_err());

        // Verify state is unchanged
        let final_count = storage::get_token_count(&env);
        assert_eq!(initial_count, final_count, "Token count should not change on batch failure");
    }

    #[test]
    fn test_batch_atomicity_valid_batch_applies_all() {
        let (env, creator) = setup_env();

        let initial_count = storage::get_token_count(&env);

        // Create valid batch
        let mut tokens = Vec::new(&env);
        tokens.push_back(create_token_params(&env, "Token1", "T1"));
        tokens.push_back(create_token_params(&env, "Token2", "T2"));
        tokens.push_back(create_token_params(&env, "Token3", "T3"));

        let base_fee = storage::get_base_fee(&env);
        let required_fee = base_fee * 3;

        // Execute batch
        let result = batch_reveal(&env, creator.clone(), tokens, required_fee);
        assert!(result.is_ok(), "Valid batch should succeed");

        let indices = result.unwrap();
        assert_eq!(indices.len(), 3, "Should return 3 token indices");

        // Verify all tokens were created
        let final_count = storage::get_token_count(&env);
        assert_eq!(
            final_count,
            initial_count + 3,
            "Token count should increase by 3"
        );

        // Verify indices are sequential
        assert_eq!(indices.get(0).unwrap(), initial_count);
        assert_eq!(indices.get(1).unwrap(), initial_count + 1);
        assert_eq!(indices.get(2).unwrap(), initial_count + 2);
    }

    #[test]
    fn test_batch_atomicity_empty_batch() {
        let (env, creator) = setup_env();

        let tokens: Vec<TokenCreationParams> = Vec::new(&env);
        let base_fee = storage::get_base_fee(&env);

        // Empty batch should fail
        let result = batch_reveal(&env, creator, tokens, base_fee);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), Error::InvalidParameters);
    }

    #[test]
    fn test_batch_atomicity_single_element() {
        let (env, creator) = setup_env();

        let initial_count = storage::get_token_count(&env);

        // Single-element batch
        let mut tokens = Vec::new(&env);
        tokens.push_back(create_token_params(&env, "SingleToken", "ST"));

        let base_fee = storage::get_base_fee(&env);

        let result = batch_reveal(&env, creator, tokens, base_fee);
        assert!(result.is_ok());

        let indices = result.unwrap();
        assert_eq!(indices.len(), 1);
        assert_eq!(indices.get(0).unwrap(), initial_count);

        let final_count = storage::get_token_count(&env);
        assert_eq!(final_count, initial_count + 1);
    }

    #[test]
    fn test_batch_atomicity_insufficient_fee() {
        let (env, creator) = setup_env();

        let initial_count = storage::get_token_count(&env);

        // Create batch
        let mut tokens = Vec::new(&env);
        tokens.push_back(create_token_params(&env, "Token1", "T1"));
        tokens.push_back(create_token_params(&env, "Token2", "T2"));

        let base_fee = storage::get_base_fee(&env);
        let insufficient_fee = base_fee;  // Only enough for 1 token

        // Should fail due to insufficient fee
        let result = batch_reveal(&env, creator, tokens, insufficient_fee);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), Error::InsufficientFee);

        // Verify state unchanged
        let final_count = storage::get_token_count(&env);
        assert_eq!(initial_count, final_count);
    }

    #[test]
    fn test_batch_atomicity_with_metadata() {
        let (env, creator) = setup_env();

        let initial_count = storage::get_token_count(&env);

        // Batch with metadata
        let mut tokens = Vec::new(&env);
        tokens.push_back(create_token_params_with_metadata(&env, "Token1", "T1"));
        tokens.push_back(create_token_params_with_metadata(&env, "Token2", "T2"));

        let base_fee = storage::get_base_fee(&env);
        let metadata_fee = storage::get_metadata_fee(&env);
        let required_fee = (base_fee + metadata_fee) * 2;

        let result = batch_reveal(&env, creator, tokens, required_fee);
        assert!(result.is_ok());

        let final_count = storage::get_token_count(&env);
        assert_eq!(final_count, initial_count + 2);
    }

    #[test]
    fn test_batch_atomicity_max_batch_size() {
        let (env, creator) = setup_env();

        // Create batch at max size
        let mut tokens = Vec::new(&env);
        for i in 0..MAX_BATCH_SIZE {
            let name = format!("Token{}", i);
            let symbol = format!("T{}", i);
            tokens.push_back(create_token_params(&env, &name, &symbol));
        }

        let base_fee = storage::get_base_fee(&env);
        let required_fee = base_fee * (MAX_BATCH_SIZE as i128);

        let result = batch_reveal(&env, creator, tokens, required_fee);
        assert!(result.is_ok());

        let indices = result.unwrap();
        assert_eq!(indices.len() as u32, MAX_BATCH_SIZE);
    }

    #[test]
    fn test_batch_atomicity_exceeds_max_size() {
        let (env, creator) = setup_env();

        // Create batch exceeding max size
        let mut tokens = Vec::new(&env);
        for i in 0..=MAX_BATCH_SIZE {
            let name = format!("Token{}", i);
            let symbol = format!("T{}", i);
            tokens.push_back(create_token_params(&env, &name, &symbol));
        }

        let base_fee = storage::get_base_fee(&env);
        let required_fee = base_fee * ((MAX_BATCH_SIZE + 1) as i128);

        let result = batch_reveal(&env, creator, tokens, required_fee);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), Error::BatchTooLarge);
    }

    #[test]
    fn test_batch_atomicity_state_consistency_after_failure() {
        let (env, creator) = setup_env();

        // First successful batch
        let mut tokens1 = Vec::new(&env);
        tokens1.push_back(create_token_params(&env, "Token1", "T1"));
        let base_fee = storage::get_base_fee(&env);
        let result1 = batch_reveal(&env, creator.clone(), tokens1, base_fee);
        assert!(result1.is_ok());

        let count_after_first = storage::get_token_count(&env);

        // Second batch with invalid element
        let mut tokens2 = Vec::new(&env);
        tokens2.push_back(create_token_params(&env, "Token2", "T2"));
        tokens2.push_back(TokenCreationParams {
            name: SorobanString::from_slice(&env, ""),  // Invalid
            symbol: SorobanString::from_slice(&env, "INVALID"),
            decimals: 7,
            initial_supply: 1_000_000_000_000,
            metadata_uri: None,
        });

        let result2 = batch_reveal(&env, creator, tokens2, base_fee * 2);
        assert!(result2.is_err());

        // Verify state is consistent with first batch
        let count_after_second = storage::get_token_count(&env);
        assert_eq!(count_after_first, count_after_second, "State should not change after failed batch");
    }
}
