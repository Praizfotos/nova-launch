//! Cross-Contract Authorization Tests (#1142)
#[cfg(test)]
mod cross_contract_auth_tests {
    use soroban_sdk::{testutils::Address as _, Address, Env};
    use crate::{TokenFactory, TokenFactoryClient};

    fn setup() -> (Env, TokenFactoryClient, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        client.initialize(&admin, &treasury, &100_000_000, &50_000_000).unwrap();
        (env, client, admin)
    }

    #[test]
    fn test_register_and_assert_trusted_caller() {
        let (env, client, admin) = setup();
        let caller = Address::generate(&env);
        client.register_trusted_caller(&admin, &caller).unwrap();
        assert!(client.try_assert_trusted_caller(&caller).is_ok());
    }

    #[test]
    fn test_unregistered_caller_rejected() {
        let (env, client, _admin) = setup();
        let spoofed = Address::generate(&env);
        assert!(client.try_assert_trusted_caller(&spoofed).is_err());
    }

    #[test]
    fn test_revoke_blocks_access() {
        let (env, client, admin) = setup();
        let caller = Address::generate(&env);
        client.register_trusted_caller(&admin, &caller).unwrap();
        client.revoke_trusted_caller(&admin, &caller).unwrap();
        assert!(client.try_assert_trusted_caller(&caller).is_err());
    }

    #[test]
    fn test_register_unauthorized() {
        let (env, client, _admin) = setup();
        let attacker = Address::generate(&env);
        let caller = Address::generate(&env);
        assert!(client.try_register_trusted_caller(&attacker, &caller).is_err());
    }

    #[test]
    fn test_revoke_unauthorized() {
        let (env, client, admin) = setup();
        let caller = Address::generate(&env);
        let attacker = Address::generate(&env);
        client.register_trusted_caller(&admin, &caller).unwrap();
        assert!(client.try_revoke_trusted_caller(&attacker, &caller).is_err());
    }

    #[test]
    fn test_events_emitted() {
        let (env, client, admin) = setup();
        let caller = Address::generate(&env);
        client.register_trusted_caller(&admin, &caller).unwrap();
        client.assert_trusted_caller(&caller).unwrap();
        client.revoke_trusted_caller(&admin, &caller).unwrap();
        assert!(env.events().all().len() >= 3);
    }
}
