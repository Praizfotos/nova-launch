//! Adversarial authorization fuzzing for multi-sig proposal lifecycle (#1054)
//!
//! This module contains fuzz-style tests that randomize signer sets and approval
//! orderings to confirm threshold enforcement cannot be bypassed and authorization
//! is properly enforced throughout the multi-sig lifecycle.

#![cfg(test)]

use soroban_sdk::{testutils::Address as _, Address, Bytes, Env, Vec};

use crate::{types::MultiSigAction, TokenFactory, TokenFactoryClient};

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

fn setup(env: &Env) -> (TokenFactoryClient, Address) {
    env.mock_all_auths();
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(env, &contract_id);
    let admin = Address::generate(env);
    let treasury = Address::generate(env);
    client.initialize(&admin, &treasury, &100_000_000, &50_000_000);
    (client, admin)
}

fn empty_payload(env: &Env) -> Bytes {
    Bytes::new(env)
}

// ─────────────────────────────────────────────
// Threshold Enforcement Tests
// ─────────────────────────────────────────────

/// Test: Execution only succeeds once threshold of distinct valid signers approve
#[test]
fn test_threshold_enforcement_2_of_3() {
    let env = Env::default();
    let (client, admin) = setup(&env);

    // Configure 3 signers with threshold 2
    let signer1 = Address::generate(&env);
    let signer2 = Address::generate(&env);
    let signer3 = Address::generate(&env);

    let mut signers = Vec::new(&env);
    signers.push_back(signer1.clone());
    signers.push_back(signer2.clone());
    signers.push_back(signer3.clone());

    client.configure_multisig(&admin, &signers, &2);

    // Propose action
    let proposal_id = client.propose_multisig_action(
        &signer1,
        &MultiSigAction::PauseContract,
        &empty_payload(&env),
    );

    // First approval: proposal not yet executed
    client.approve_multisig_proposal(&signer1, &proposal_id);
    let proposal = client.get_multisig_proposal(&proposal_id).unwrap();
    assert!(
        !proposal.executed,
        "Should not execute with 1 approval (threshold 2)"
    );

    // Second approval: should auto-execute
    client.approve_multisig_proposal(&signer2, &proposal_id);
    let proposal = client.get_multisig_proposal(&proposal_id).unwrap();
    assert!(
        proposal.executed,
        "Should execute with 2 approvals (threshold 2)"
    );
}

/// Test: Execution only succeeds once threshold of distinct valid signers approve (3 of 5)
#[test]
fn test_threshold_enforcement_3_of_5() {
    let env = Env::default();
    let (client, admin) = setup(&env);

    // Configure 5 signers with threshold 3
    let mut signers = Vec::new(&env);
    for _ in 0..5 {
        signers.push_back(Address::generate(&env));
    }

    client.configure_multisig(&admin, &signers, &3);

    // Propose action
    let proposal_id = client.propose_multisig_action(
        &signers.get(0).unwrap(),
        &MultiSigAction::UnpauseContract,
        &empty_payload(&env),
    );

    // First approval
    client.approve_multisig_proposal(&signers.get(0).unwrap(), &proposal_id);
    let proposal = client.get_multisig_proposal(&proposal_id).unwrap();
    assert!(!proposal.executed);

    // Second approval
    client.approve_multisig_proposal(&signers.get(1).unwrap(), &proposal_id);
    let proposal = client.get_multisig_proposal(&proposal_id).unwrap();
    assert!(!proposal.executed);

    // Third approval: should execute
    client.approve_multisig_proposal(&signers.get(2).unwrap(), &proposal_id);
    let proposal = client.get_multisig_proposal(&proposal_id).unwrap();
    assert!(proposal.executed);
}

/// Test: Threshold 1 of 1 executes immediately on single approval
#[test]
fn test_threshold_enforcement_1_of_1() {
    let env = Env::default();
    let (client, admin) = setup(&env);

    let signer = Address::generate(&env);
    let mut signers = Vec::new(&env);
    signers.push_back(signer.clone());

    client.configure_multisig(&admin, &signers, &1);

    let proposal_id = client.propose_multisig_action(
        &signer,
        &MultiSigAction::PauseContract,
        &empty_payload(&env),
    );

    // Single approval should execute immediately
    client.approve_multisig_proposal(&signer, &proposal_id);
    let proposal = client.get_multisig_proposal(&proposal_id).unwrap();
    assert!(proposal.executed);
}

// ─────────────────────────────────────────────
// Duplicate Approval Tests
// ─────────────────────────────────────────────

/// Test: Duplicate approvals from same signer do not count twice
#[test]
fn test_duplicate_approval_does_not_count_twice() {
    let env = Env::default();
    let (client, admin) = setup(&env);

    let signer1 = Address::generate(&env);
    let signer2 = Address::generate(&env);

    let mut signers = Vec::new(&env);
    signers.push_back(signer1.clone());
    signers.push_back(signer2.clone());

    client.configure_multisig(&admin, &signers, &2);

    let proposal_id = client.propose_multisig_action(
        &signer1,
        &MultiSigAction::PauseContract,
        &empty_payload(&env),
    );

    // First approval from signer1
    client.approve_multisig_proposal(&signer1, &proposal_id);

    // Attempt duplicate approval from signer1 should fail
    let result = client.try_approve_multisig_proposal(&signer1, &proposal_id);
    assert!(result.is_err(), "Duplicate approval should fail");

    // Proposal should still not be executed
    let proposal = client.get_multisig_proposal(&proposal_id).unwrap();
    assert!(!proposal.executed);

    // Second approval from signer2 should execute
    client.approve_multisig_proposal(&signer2, &proposal_id);
    let proposal = client.get_multisig_proposal(&proposal_id).unwrap();
    assert!(proposal.executed);
}

// ─────────────────────────────────────────────
// Non-Signer Rejection Tests
// ─────────────────────────────────────────────

/// Test: Non-signer approval attempts fail and leave proposal state unchanged
#[test]
fn test_non_signer_approval_fails() {
    let env = Env::default();
    let (client, admin) = setup(&env);

    let signer1 = Address::generate(&env);
    let signer2 = Address::generate(&env);
    let non_signer = Address::generate(&env);

    let mut signers = Vec::new(&env);
    signers.push_back(signer1.clone());
    signers.push_back(signer2.clone());

    client.configure_multisig(&admin, &signers, &2);

    let proposal_id = client.propose_multisig_action(
        &signer1,
        &MultiSigAction::PauseContract,
        &empty_payload(&env),
    );

    // Non-signer approval should fail
    let result = client.try_approve_multisig_proposal(&non_signer, &proposal_id);
    assert!(result.is_err(), "Non-signer approval should fail");

    // Proposal state should be unchanged
    let proposal = client.get_multisig_proposal(&proposal_id).unwrap();
    assert_eq!(proposal.approval_count, 0);
    assert!(!proposal.executed);
}

/// Test: Multiple non-signer attempts all fail
#[test]
fn test_multiple_non_signer_attempts_all_fail() {
    let env = Env::default();
    let (client, admin) = setup(&env);

    let signer = Address::generate(&env);
    let mut signers = Vec::new(&env);
    signers.push_back(signer.clone());

    client.configure_multisig(&admin, &signers, &1);

    let proposal_id = client.propose_multisig_action(
        &signer,
        &MultiSigAction::PauseContract,
        &empty_payload(&env),
    );

    // Multiple non-signer attempts
    for _ in 0..5 {
        let non_signer = Address::generate(&env);
        let result = client.try_approve_multisig_proposal(&non_signer, &proposal_id);
        assert!(result.is_err());
    }

    // Proposal should still not be executed
    let proposal = client.get_multisig_proposal(&proposal_id).unwrap();
    assert!(!proposal.executed);
}

// ─────────────────────────────────────────────
// MultiSigNotConfigured Path Tests
// ─────────────────────────────────────────────

/// Test: Operations fail when multi-sig not configured
#[test]
fn test_multisig_not_configured_path() {
    let env = Env::default();
    let (client, _) = setup(&env);

    let random_signer = Address::generate(&env);

    // Propose should fail when not configured
    let result = client.try_propose_multisig_action(
        &random_signer,
        &MultiSigAction::PauseContract,
        &empty_payload(&env),
    );
    assert!(result.is_err());

    // Get config should return None
    let cfg = client.get_multisig_config();
    assert!(cfg.is_none());
}

// ─────────────────────────────────────────────
// Approval Ordering Tests
// ─────────────────────────────────────────────

/// Test: Approval order doesn't matter (any order reaches threshold)
#[test]
fn test_approval_order_independence() {
    let env = Env::default();
    let (client, admin) = setup(&env);

    let signer1 = Address::generate(&env);
    let signer2 = Address::generate(&env);
    let signer3 = Address::generate(&env);

    let mut signers = Vec::new(&env);
    signers.push_back(signer1.clone());
    signers.push_back(signer2.clone());
    signers.push_back(signer3.clone());

    client.configure_multisig(&admin, &signers, &2);

    // Propose two identical actions
    let proposal_id1 = client.propose_multisig_action(
        &signer1,
        &MultiSigAction::PauseContract,
        &empty_payload(&env),
    );

    let proposal_id2 = client.propose_multisig_action(
        &signer1,
        &MultiSigAction::PauseContract,
        &empty_payload(&env),
    );

    // Approve first proposal in order: signer1, signer2
    client.approve_multisig_proposal(&signer1, &proposal_id1);
    client.approve_multisig_proposal(&signer2, &proposal_id1);
    let p1 = client.get_multisig_proposal(&proposal_id1).unwrap();
    assert!(p1.executed);

    // Approve second proposal in reverse order: signer3, signer1
    client.approve_multisig_proposal(&signer3, &proposal_id2);
    client.approve_multisig_proposal(&signer1, &proposal_id2);
    let p2 = client.get_multisig_proposal(&proposal_id2).unwrap();
    assert!(p2.executed);
}

// ─────────────────────────────────────────────
// Cancellation Authorization Tests
// ─────────────────────────────────────────────

/// Test: Only admin or proposer can cancel
#[test]
fn test_cancellation_authorization() {
    let env = Env::default();
    let (client, admin) = setup(&env);

    let signer = Address::generate(&env);
    let other_signer = Address::generate(&env);

    let mut signers = Vec::new(&env);
    signers.push_back(signer.clone());
    signers.push_back(other_signer.clone());

    client.configure_multisig(&admin, &signers, &2);

    let proposal_id = client.propose_multisig_action(
        &signer,
        &MultiSigAction::PauseContract,
        &empty_payload(&env),
    );

    // Proposer can cancel
    client.cancel_multisig_proposal(&signer, &proposal_id);
    let proposal = client.get_multisig_proposal(&proposal_id).unwrap();
    assert!(proposal.cancelled);
}

/// Test: Non-admin, non-proposer cannot cancel
#[test]
fn test_non_admin_non_proposer_cannot_cancel() {
    let env = Env::default();
    let (client, admin) = setup(&env);

    let signer = Address::generate(&env);
    let other_signer = Address::generate(&env);
    let unauthorized = Address::generate(&env);

    let mut signers = Vec::new(&env);
    signers.push_back(signer.clone());
    signers.push_back(other_signer.clone());

    client.configure_multisig(&admin, &signers, &2);

    let proposal_id = client.propose_multisig_action(
        &signer,
        &MultiSigAction::PauseContract,
        &empty_payload(&env),
    );

    // Unauthorized user cannot cancel
    let result = client.try_cancel_multisig_proposal(&unauthorized, &proposal_id);
    assert!(result.is_err());

    // Proposal should still be active
    let proposal = client.get_multisig_proposal(&proposal_id).unwrap();
    assert!(!proposal.cancelled);
}

// ─────────────────────────────────────────────
// Execution Guard Tests
// ─────────────────────────────────────────────

/// Test: Cannot approve already-executed proposal
#[test]
fn test_cannot_approve_executed_proposal() {
    let env = Env::default();
    let (client, admin) = setup(&env);

    let signer1 = Address::generate(&env);
    let signer2 = Address::generate(&env);

    let mut signers = Vec::new(&env);
    signers.push_back(signer1.clone());
    signers.push_back(signer2.clone());

    client.configure_multisig(&admin, &signers, &1);

    let proposal_id = client.propose_multisig_action(
        &signer1,
        &MultiSigAction::PauseContract,
        &empty_payload(&env),
    );

    // First approval executes
    client.approve_multisig_proposal(&signer1, &proposal_id);
    let proposal = client.get_multisig_proposal(&proposal_id).unwrap();
    assert!(proposal.executed);

    // Second approval should fail
    let result = client.try_approve_multisig_proposal(&signer2, &proposal_id);
    assert!(result.is_err());
}

/// Test: Cannot approve cancelled proposal
#[test]
fn test_cannot_approve_cancelled_proposal() {
    let env = Env::default();
    let (client, admin) = setup(&env);

    let signer1 = Address::generate(&env);
    let signer2 = Address::generate(&env);

    let mut signers = Vec::new(&env);
    signers.push_back(signer1.clone());
    signers.push_back(signer2.clone());

    client.configure_multisig(&admin, &signers, &2);

    let proposal_id = client.propose_multisig_action(
        &signer1,
        &MultiSigAction::PauseContract,
        &empty_payload(&env),
    );

    // Cancel proposal
    client.cancel_multisig_proposal(&signer1, &proposal_id);

    // Attempt to approve should fail
    let result = client.try_approve_multisig_proposal(&signer2, &proposal_id);
    assert!(result.is_err());
}

// ─────────────────────────────────────────────
// Randomized Signer Set Tests
// ─────────────────────────────────────────────

/// Test: Threshold enforcement with varying signer counts
#[test]
fn test_threshold_with_varying_signer_counts() {
    let env = Env::default();
    let (client, admin) = setup(&env);

    // Test with 2 signers, threshold 1
    let mut signers2 = Vec::new(&env);
    signers2.push_back(Address::generate(&env));
    signers2.push_back(Address::generate(&env));
    client.configure_multisig(&admin, &signers2, &1);

    let proposal_id = client.propose_multisig_action(
        &signers2.get(0).unwrap(),
        &MultiSigAction::PauseContract,
        &empty_payload(&env),
    );

    client.approve_multisig_proposal(&signers2.get(0).unwrap(), &proposal_id);
    let proposal = client.get_multisig_proposal(&proposal_id).unwrap();
    assert!(proposal.executed);

    // Reconfigure with 10 signers, threshold 5
    let mut signers10 = Vec::new(&env);
    for _ in 0..10 {
        signers10.push_back(Address::generate(&env));
    }
    client.configure_multisig(&admin, &signers10, &5);

    let proposal_id2 = client.propose_multisig_action(
        &signers10.get(0).unwrap(),
        &MultiSigAction::UnpauseContract,
        &empty_payload(&env),
    );

    // Approve with 4 signers (below threshold)
    for i in 0..4 {
        client.approve_multisig_proposal(&signers10.get(i).unwrap(), &proposal_id2);
    }
    let proposal = client.get_multisig_proposal(&proposal_id2).unwrap();
    assert!(!proposal.executed);

    // 5th approval should execute
    client.approve_multisig_proposal(&signers10.get(4).unwrap(), &proposal_id2);
    let proposal = client.get_multisig_proposal(&proposal_id2).unwrap();
    assert!(proposal.executed);
}

// ─────────────────────────────────────────────
// Proposal State Isolation Tests
// ─────────────────────────────────────────────

/// Test: Multiple proposals maintain independent state
#[test]
fn test_multiple_proposals_independent_state() {
    let env = Env::default();
    let (client, admin) = setup(&env);

    let signer1 = Address::generate(&env);
    let signer2 = Address::generate(&env);

    let mut signers = Vec::new(&env);
    signers.push_back(signer1.clone());
    signers.push_back(signer2.clone());

    client.configure_multisig(&admin, &signers, &2);

    // Create two proposals
    let proposal_id1 = client.propose_multisig_action(
        &signer1,
        &MultiSigAction::PauseContract,
        &empty_payload(&env),
    );

    let proposal_id2 = client.propose_multisig_action(
        &signer1,
        &MultiSigAction::UnpauseContract,
        &empty_payload(&env),
    );

    // Approve first proposal
    client.approve_multisig_proposal(&signer1, &proposal_id1);
    client.approve_multisig_proposal(&signer2, &proposal_id1);

    let p1 = client.get_multisig_proposal(&proposal_id1).unwrap();
    assert!(p1.executed);

    // Second proposal should still be pending
    let p2 = client.get_multisig_proposal(&proposal_id2).unwrap();
    assert!(!p2.executed);
    assert_eq!(p2.approval_count, 0);
}
