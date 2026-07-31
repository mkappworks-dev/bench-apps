use std::collections::HashMap;
use std::sync::Mutex;

/// Keychain service name. Stable across releases — changing it orphans every
/// stored key.
pub const SERVICE: &str = "com.benchapps.devbench";

/// OS-native secret storage, behind a trait for one concrete reason: a
/// keychain is an ambient OS resource, and a headless CI box has no Secret
/// Service provider at all. Tests use `InMemorySecretStore` so they exercise
/// the calling code without depending on the machine they run on.
pub trait SecretStore: Send + Sync {
    fn set(&self, account: &str, secret: &str) -> Result<(), String>;
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn clear(&self, account: &str) -> Result<(), String>;
}

pub struct KeyringSecretStore;

impl SecretStore for KeyringSecretStore {
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE, account)
            .map_err(|e| format!("cannot open the OS keychain: {e}"))?;
        entry.set_password(secret).map_err(|e| format!("cannot store the key: {e}"))
    }

    fn get(&self, account: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(SERVICE, account)
            .map_err(|e| format!("cannot open the OS keychain: {e}"))?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("cannot read the key: {e}")),
        }
    }

    fn clear(&self, account: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE, account)
            .map_err(|e| format!("cannot open the OS keychain: {e}"))?;
        match entry.delete_credential() {
            // Deleting something that is already gone is the desired end state.
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("cannot delete the key: {e}")),
        }
    }
}

#[derive(Default)]
pub struct InMemorySecretStore {
    entries: Mutex<HashMap<String, String>>,
}

impl SecretStore for InMemorySecretStore {
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        self.entries
            .lock()
            .map_err(|_| "secret store poisoned".to_string())?
            .insert(account.to_string(), secret.to_string());
        Ok(())
    }

    fn get(&self, account: &str) -> Result<Option<String>, String> {
        Ok(self
            .entries
            .lock()
            .map_err(|_| "secret store poisoned".to_string())?
            .get(account)
            .cloned())
    }

    fn clear(&self, account: &str) -> Result<(), String> {
        self.entries
            .lock()
            .map_err(|_| "secret store poisoned".to_string())?
            .remove(account);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_memory_store_round_trips_and_clears() {
        let store = InMemorySecretStore::default();
        assert_eq!(store.get("anthropic").unwrap(), None);
        store.set("anthropic", "sk-ant-test").unwrap();
        assert_eq!(store.get("anthropic").unwrap().as_deref(), Some("sk-ant-test"));
        store.clear("anthropic").unwrap();
        assert_eq!(store.get("anthropic").unwrap(), None);
    }

    #[test]
    fn clearing_an_absent_secret_is_not_an_error() {
        let store = InMemorySecretStore::default();
        assert!(store.clear("never-set").is_ok());
    }

    /// Exercises the REAL keychain. Ignored by default: a headless CI box has
    /// no Secret Service provider, so this would fail for reasons unrelated to
    /// the code. Run manually with:
    ///     cargo test -- --ignored keyring_store_round_trips
    #[test]
    #[ignore]
    fn keyring_store_round_trips_against_the_real_os_keychain() {
        let store = KeyringSecretStore;
        let account = "devbench-test-account";
        store.set(account, "sk-ant-manual-test").unwrap();
        assert_eq!(store.get(account).unwrap().as_deref(), Some("sk-ant-manual-test"));
        store.clear(account).unwrap();
        assert_eq!(store.get(account).unwrap(), None);
    }
}
