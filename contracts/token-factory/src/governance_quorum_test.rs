//! Token-Weighted Governance Quorum Tests (#1140)
#[cfg(test)]
mod governance_quorum_tests {
    use soroban_sdk::{testutils::Address as _, Address, Env};
    use crate::{governance, storage, timelock::{create_proposal, finalize_proposal, get_proposal, initialize_timelock, vote_proposal}, types::{ActionType, VoteChoice}, TokenFactory};

    fn setup() -> (Env, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, TokenFactory);
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        env.as_contract(&contract_id, || {
            storage::set_admin(&env, &admin);
            storage::set_treasury(&env, &treasury);
            storage::set_base_fee(&env, 1_000_000);
            storage::set_metadata_fee(&env, 500_000);
            initialize_timelock(&env, Some(3_600)).unwrap();
            governance::initialize_governance(&env, Some(30), Some(51)).unwrap();
        });
        (env, contract_id, admin)
    }

    #[test]
    fn test_quorum_met_proposal_succeeds() {
        let (env, cid, admin) = setup();
        let pid = env.as_contract(&cid, || {
            let now = env.ledger().timestamp();
            create_proposal(&env, &admin, ActionType::FeeChange, soroban_sdk::Bytes::new(&env), now + 100, now + 86_500, now + 90_100).unwrap()
        });
        env.ledger().with_mut(|li| li.timestamp += 200);
        env.as_contract(&cid, || {
            for _ in 0..7 { vote_proposal(&env, &Address::generate(&env), pid, VoteChoice::For).unwrap(); }
            for _ in 0..3 { vote_proposal(&env, &Address::generate(&env), pid, VoteChoice::Against).unwrap(); }
        });
        env.ledger().with_mut(|li| li.timestamp += 90_000);
        env.as_contract(&cid, || {
            finalize_proposal(&env, pid).unwrap();
            let p = get_proposal(&env, pid).unwrap();
            assert_eq!(p.state, crate::types::ProposalState::Succeeded);
        });
    }

    #[test]
    fn test_quorum_not_met_proposal_fails() {
        let (env, cid, admin) = setup();
        let pid = env.as_contract(&cid, || {
            let now = env.ledger().timestamp();
            create_proposal(&env, &admin, ActionType::FeeChange, soroban_sdk::Bytes::new(&env), now + 100, now + 86_500, now + 90_100).unwrap()
        });
        env.ledger().with_mut(|li| li.timestamp += 90_000);
        env.as_contract(&cid, || {
            finalize_proposal(&env, pid).unwrap();
            let p = get_proposal(&env, pid).unwrap();
            assert_eq!(p.state, crate::types::ProposalState::Failed);
        });
    }

    #[test]
    fn test_quorum_threshold_configurable() {
        let (env, cid, admin) = setup();
        env.as_contract(&cid, || {
            governance::update_governance_config(&env, &admin, Some(50), None).unwrap();
            assert_eq!(governance::get_governance_config(&env).quorum_percent, 50);
        });
    }

    #[test]
    fn test_is_quorum_met_basic() {
        assert!(governance::is_quorum_met(3, 10, 30));
        assert!(!governance::is_quorum_met(2, 10, 30));
        assert!(!governance::is_quorum_met(5, 0, 30));
    }
}
