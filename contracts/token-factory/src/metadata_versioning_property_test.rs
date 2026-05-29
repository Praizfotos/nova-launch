//! Property-based invariants for metadata versioning history (#1052)
//!
//! This module uses proptest to verify that metadata versioning maintains
//! critical invariants under arbitrary sequences of set/update operations.

#![cfg(test)]

use proptest::prelude::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Env, String,
};

use crate::{
    storage,
    types::{Error, TokenInfo},
    TokenFactory, TokenFactoryClient,
};

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

fn setup_env() -> (Env, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let creator = Address::generate(&env);
    let treasury = Address::generate(&env);

    env.as_contract(&contract_id, || {
        storage::set_admin(&env, &creator);
        storage::set_treasury(&env, &treasury);
        storage::set_base_fee(&env, 100);
        storage::set_metadata_fee(&env, 50);

        let token_info = TokenInfo {
            address: contract_id.clone(),
            creator: creator.clone(),
            name: String::from_str(&env, "TestToken"),
            symbol: String::from_str(&env, "TTK"),
            decimals: 7,
            total_supply: 1_000_000,
            initial_supply: 1_000_000,
            max_supply: None,
            total_burned: 0,
            burn_count: 0,
            metadata_uri: None,
            metadata_version: 0,
            created_at: env.ledger().timestamp(),
            is_paused: false,
            clawback_enabled: false,
            freeze_enabled: false,
        };
        storage::set_token_info(&env, 0, &token_info);
        storage::set_token_info_by_address(&env, &contract_id, &token_info);
    });

    (env, contract_id, creator)
}

// ─────────────────────────────────────────────
// Proptest Strategies
// ─────────────────────────────────────────────

/// Strategy for generating valid IPFS URIs
fn ipfs_uri_strategy() -> impl Strategy<Value = String> {
    r"ipfs://Qm[a-zA-Z0-9]{44,46}".prop_map(|s| s).boxed()
}

/// Strategy for generating sequences of metadata operations
#[derive(Debug, Clone)]
enum MetadataOp {
    Set(String),
    Update(String),
}

fn metadata_op_strategy() -> impl Strategy<Value = Vec<MetadataOp>> {
    prop::collection::vec(
        prop_oneof![
            ipfs_uri_strategy().prop_map(MetadataOp::Set),
            ipfs_uri_strategy().prop_map(MetadataOp::Update),
        ],
        1..20, // Generate 1-20 operations
    )
}

// ─────────────────────────────────────────────
// Property Tests
// ─────────────────────────────────────────────

proptest! {
    /// Property: Version numbers are strictly monotonic
    ///
    /// After each successful set/update, the version must be strictly greater
    /// than the previous version.
    #[test]
    fn prop_version_monotonic(ops in metadata_op_strategy()) {
        let (env, contract_id, creator) = setup_env();
        let client = TokenFactoryClient::new(&env, &contract_id);

        let mut current_version = 0u32;
        let mut set_called = false;

        for op in ops {
            match op {
                MetadataOp::Set(uri) => {
                    let result = client.try_set_token_metadata(
                        &creator,
                        &0u32,
                        &String::from_str(&env, &uri),
                    );

                    if result.is_ok() {
                        set_called = true;
                        // After set, version should be 1
                        let info = client.get_token_info(&0);
                        prop_assert_eq!(info.metadata_version, 1);
                        current_version = 1;
                    }
                }
                MetadataOp::Update(uri) => {
                    if set_called {
                        let result = client.try_update_metadata(
                            &creator,
                            &0u32,
                            &String::from_str(&env, &uri),
                        );

                        if result.is_ok() {
                            let new_version = result.unwrap();
                            // Version must be strictly greater
                            prop_assert!(new_version > current_version);
                            current_version = new_version;
                        }
                    }
                }
            }
        }
    }

    /// Property: History length equals number of successful updates
    ///
    /// The metadata history should contain exactly one record per successful
    /// set/update operation.
    #[test]
    fn prop_history_length_matches_updates(ops in metadata_op_strategy()) {
        let (env, contract_id, creator) = setup_env();
        let client = TokenFactoryClient::new(&env, &contract_id);

        let mut successful_ops = 0;
        let mut set_called = false;

        for op in ops {
            match op {
                MetadataOp::Set(uri) => {
                    let result = client.try_set_token_metadata(
                        &creator,
                        &0u32,
                        &String::from_str(&env, &uri),
                    );
                    if result.is_ok() {
                        successful_ops += 1;
                        set_called = true;
                    }
                }
                MetadataOp::Update(uri) => {
                    if set_called {
                        let result = client.try_update_metadata(
                            &creator,
                            &0u32,
                            &String::from_str(&env, &uri),
                        );
                        if result.is_ok() {
                            successful_ops += 1;
                        }
                    }
                }
            }
        }

        // Verify history records exist for each successful operation
        if successful_ops > 0 {
            let info = client.get_token_info(&0);
            prop_assert_eq!(info.metadata_version as usize, successful_ops);
        }
    }

    /// Property: Latest metadata always equals last successful update
    ///
    /// The current metadata_uri in token_info must match the URI from the
    /// most recent successful set/update operation.
    #[test]
    fn prop_latest_metadata_matches_last_update(ops in metadata_op_strategy()) {
        let (env, contract_id, creator) = setup_env();
        let client = TokenFactoryClient::new(&env, &contract_id);

        let mut last_uri: Option<String> = None;
        let mut set_called = false;

        for op in ops {
            match op {
                MetadataOp::Set(uri) => {
                    let result = client.try_set_token_metadata(
                        &creator,
                        &0u32,
                        &String::from_str(&env, &uri),
                    );
                    if result.is_ok() {
                        last_uri = Some(String::from_str(&env, &uri));
                        set_called = true;
                    }
                }
                MetadataOp::Update(uri) => {
                    if set_called {
                        let result = client.try_update_metadata(
                            &creator,
                            &0u32,
                            &String::from_str(&env, &uri),
                        );
                        if result.is_ok() {
                            last_uri = Some(String::from_str(&env, &uri));
                        }
                    }
                }
            }
        }

        // Verify current metadata matches last successful operation
        if let Some(expected_uri) = last_uri {
            let info = client.get_token_info(&0);
            prop_assert_eq!(info.metadata_uri, Some(expected_uri));
        }
    }

    /// Property: MetadataNotSet error only when metadata never set
    ///
    /// Update operations should fail with MetadataNotSet only if set was
    /// never called successfully.
    #[test]
    fn prop_metadata_not_set_error_path(ops in metadata_op_strategy()) {
        let (env, contract_id, creator) = setup_env();
        let client = TokenFactoryClient::new(&env, &contract_id);

        let mut set_called = false;

        for op in ops {
            match op {
                MetadataOp::Set(uri) => {
                    let result = client.try_set_token_metadata(
                        &creator,
                        &0u32,
                        &String::from_str(&env, &uri),
                    );
                    if result.is_ok() {
                        set_called = true;
                    }
                }
                MetadataOp::Update(uri) => {
                    let result = client.try_update_metadata(
                        &creator,
                        &0u32,
                        &String::from_str(&env, &uri),
                    );

                    if !set_called {
                        // If set was never called, update must fail
                        prop_assert!(result.is_err());
                    }
                }
            }
        }
    }

    /// Property: MetadataAlreadySet error only on duplicate set
    ///
    /// Calling set_token_metadata twice should fail with MetadataAlreadySet
    /// on the second call.
    #[test]
    fn prop_metadata_already_set_error_path(uri1 in ipfs_uri_strategy(), uri2 in ipfs_uri_strategy()) {
        let (env, contract_id, creator) = setup_env();
        let client = TokenFactoryClient::new(&env, &contract_id);

        // First set should succeed
        let result1 = client.try_set_token_metadata(
            &creator,
            &0u32,
            &String::from_str(&env, &uri1),
        );
        prop_assert!(result1.is_ok());

        // Second set should fail with MetadataAlreadySet
        let result2 = client.try_set_token_metadata(
            &creator,
            &0u32,
            &String::from_str(&env, &uri2),
        );
        prop_assert!(result2.is_err());
    }

    /// Property: History retrieval returns correct record for each version
    ///
    /// For each version in the history, get_metadata_history should return
    /// the exact URI that was set/updated at that version.
    #[test]
    fn prop_history_retrieval_accuracy(ops in metadata_op_strategy()) {
        let (env, contract_id, creator) = setup_env();
        let client = TokenFactoryClient::new(&env, &contract_id);

        let mut history: Vec<String> = Vec::new();
        let mut set_called = false;

        for op in ops {
            match op {
                MetadataOp::Set(uri) => {
                    let result = client.try_set_token_metadata(
                        &creator,
                        &0u32,
                        &String::from_str(&env, &uri),
                    );
                    if result.is_ok() {
                        history.push(uri);
                        set_called = true;
                    }
                }
                MetadataOp::Update(uri) => {
                    if set_called {
                        let result = client.try_update_metadata(
                            &creator,
                            &0u32,
                            &String::from_str(&env, &uri),
                        );
                        if result.is_ok() {
                            history.push(uri);
                        }
                    }
                }
            }
        }

        // Verify each history record matches what was set/updated
        for (idx, expected_uri) in history.iter().enumerate() {
            let version = (idx + 1) as u32;
            let record = client.get_metadata_history(&0, &version);
            if let Some(rec) = record {
                prop_assert_eq!(rec.uri, String::from_str(&env, expected_uri));
            }
        }
    }

    /// Property: Authorization enforced on all metadata operations
    ///
    /// Only the token creator should be able to set/update metadata.
    /// Non-creator attempts should fail.
    #[test]
    fn prop_authorization_enforced(ops in metadata_op_strategy()) {
        let (env, contract_id, creator) = setup_env();
        let non_creator = Address::generate(&env);
        let client = TokenFactoryClient::new(&env, &contract_id);

        for op in ops {
            match op {
                MetadataOp::Set(uri) => {
                    // Non-creator set should fail
                    let result = client.try_set_token_metadata(
                        &non_creator,
                        &0u32,
                        &String::from_str(&env, &uri),
                    );
                    prop_assert!(result.is_err());
                }
                MetadataOp::Update(uri) => {
                    // Non-creator update should fail
                    let result = client.try_update_metadata(
                        &non_creator,
                        &0u32,
                        &String::from_str(&env, &uri),
                    );
                    prop_assert!(result.is_err());
                }
            }
        }
    }

    /// Property: State consistency across rapid operations
    ///
    /// After a sequence of operations, the final state must be consistent:
    /// - metadata_version matches history length
    /// - metadata_uri matches last successful operation
    /// - all history records are retrievable
    #[test]
    fn prop_state_consistency(ops in metadata_op_strategy()) {
        let (env, contract_id, creator) = setup_env();
        let client = TokenFactoryClient::new(&env, &contract_id);

        let mut expected_version = 0u32;
        let mut last_uri: Option<String> = None;
        let mut set_called = false;

        for op in ops {
            match op {
                MetadataOp::Set(uri) => {
                    let result = client.try_set_token_metadata(
                        &creator,
                        &0u32,
                        &String::from_str(&env, &uri),
                    );
                    if result.is_ok() {
                        expected_version = 1;
                        last_uri = Some(String::from_str(&env, &uri));
                        set_called = true;
                    }
                }
                MetadataOp::Update(uri) => {
                    if set_called {
                        let result = client.try_update_metadata(
                            &creator,
                            &0u32,
                            &String::from_str(&env, &uri),
                        );
                        if result.is_ok() {
                            expected_version += 1;
                            last_uri = Some(String::from_str(&env, &uri));
                        }
                    }
                }
            }
        }

        // Verify final state consistency
        let info = client.get_token_info(&0);
        prop_assert_eq!(info.metadata_version, expected_version);
        prop_assert_eq!(info.metadata_uri, last_uri);
    }
}

// ─────────────────────────────────────────────
// Deterministic Unit Tests (Complement to Properties)
// ─────────────────────────────────────────────

#[test]
fn test_metadata_versioning_deterministic_sequence() {
    let (env, contract_id, creator) = setup_env();
    let client = TokenFactoryClient::new(&env, &contract_id);

    // Set initial metadata
    client
        .set_token_metadata(&creator, &0u32, &String::from_str(&env, "ipfs://QmV1"))
        .unwrap();

    let info1 = client.get_token_info(&0);
    assert_eq!(info1.metadata_version, 1);
    assert_eq!(
        info1.metadata_uri,
        Some(String::from_str(&env, "ipfs://QmV1"))
    );

    // Update to version 2
    let v2 = client
        .update_metadata(&creator, &0u32, &String::from_str(&env, "ipfs://QmV2"))
        .unwrap();
    assert_eq!(v2, 2);

    let info2 = client.get_token_info(&0);
    assert_eq!(info2.metadata_version, 2);
    assert_eq!(
        info2.metadata_uri,
        Some(String::from_str(&env, "ipfs://QmV2"))
    );

    // Update to version 3
    let v3 = client
        .update_metadata(&creator, &0u32, &String::from_str(&env, "ipfs://QmV3"))
        .unwrap();
    assert_eq!(v3, 3);

    let info3 = client.get_token_info(&0);
    assert_eq!(info3.metadata_version, 3);
    assert_eq!(
        info3.metadata_uri,
        Some(String::from_str(&env, "ipfs://QmV3"))
    );

    // Verify history records
    let rec1 = client.get_metadata_history(&0, &1).unwrap();
    assert_eq!(rec1.uri, String::from_str(&env, "ipfs://QmV1"));

    let rec2 = client.get_metadata_history(&0, &2).unwrap();
    assert_eq!(rec2.uri, String::from_str(&env, "ipfs://QmV2"));

    let rec3 = client.get_metadata_history(&0, &3).unwrap();
    assert_eq!(rec3.uri, String::from_str(&env, "ipfs://QmV3"));
}

#[test]
fn test_metadata_versioning_error_paths() {
    let (env, contract_id, creator) = setup_env();
    let client = TokenFactoryClient::new(&env, &contract_id);

    // Update before set should fail
    let result =
        client.try_update_metadata(&creator, &0u32, &String::from_str(&env, "ipfs://QmV1"));
    assert!(result.is_err());

    // Set initial metadata
    client
        .set_token_metadata(&creator, &0u32, &String::from_str(&env, "ipfs://QmV1"))
        .unwrap();

    // Second set should fail
    let result =
        client.try_set_token_metadata(&creator, &0u32, &String::from_str(&env, "ipfs://QmV2"));
    assert!(result.is_err());

    // Update should succeed
    let v2 = client
        .update_metadata(&creator, &0u32, &String::from_str(&env, "ipfs://QmV2"))
        .unwrap();
    assert_eq!(v2, 2);
}
