use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Keychain service name. Stable across releases — changing it orphans every
/// stored key.
pub const SERVICE: &str = "app.benchlabs.devbench";

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

/// Dev-only fallback for the OS keychain.
///
/// macOS binds a keychain ACL to the exact binary that asked for it, and a
/// `cargo build` produces an ad-hoc signature (`Signature=adhoc`,
/// `TeamIdentifier=not set`) that changes on every relink. So the running
/// binary is a different application to the keychain after each rebuild,
/// "Always Allow" can never stick, and the prompt returns on every launch.
/// Release builds are signed once with a stable identity and keep the keychain.
///
/// The file is deliberately plain: it exists so a developer stops being asked
/// for their login password to reach a localhost Postgres password. Nothing
/// reaches it in a release build — see `default_store`.
pub struct FileSecretStore {
    path: PathBuf,
    // Serializes the read-modify-write below. Two commands writing different
    // accounts concurrently would otherwise each save a map missing the
    // other's entry.
    lock: Mutex<()>,
}

impl FileSecretStore {
    pub fn new(data_dir: &Path) -> Self {
        Self { path: data_dir.join("dev-secrets.json"), lock: Mutex::new(()) }
    }

    fn read_map(&self) -> Result<HashMap<String, String>, String> {
        match std::fs::read_to_string(&self.path) {
            Ok(raw) => serde_json::from_str(&raw)
                .map_err(|e| format!("dev secret file is not readable JSON: {e}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
            Err(e) => Err(format!("cannot read the dev secret file: {e}")),
        }
    }

    fn write_map(&self, map: &HashMap<String, String>) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("cannot create the dev secret directory: {e}"))?;
        }
        let raw = serde_json::to_string_pretty(map)
            .map_err(|e| format!("cannot serialize the dev secret file: {e}"))?;
        std::fs::write(&self.path, raw)
            .map_err(|e| format!("cannot write the dev secret file: {e}"))?;
        // Owner-only. It holds real passwords, dev or not.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| format!("cannot restrict the dev secret file: {e}"))?;
        }
        Ok(())
    }
}

impl SecretStore for FileSecretStore {
    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        let _guard = self.lock.lock().map_err(|_| "secret store poisoned".to_string())?;
        let mut map = self.read_map()?;
        map.insert(account.to_string(), secret.to_string());
        self.write_map(&map)
    }

    fn get(&self, account: &str) -> Result<Option<String>, String> {
        let _guard = self.lock.lock().map_err(|_| "secret store poisoned".to_string())?;
        Ok(self.read_map()?.get(account).cloned())
    }

    fn clear(&self, account: &str) -> Result<(), String> {
        let _guard = self.lock.lock().map_err(|_| "secret store poisoned".to_string())?;
        let mut map = self.read_map()?;
        map.remove(account);
        self.write_map(&map)
    }
}

/// The store this build uses. A release build is always the OS keychain — the
/// `cfg` is what stops a dev-only convenience becoming a release security
/// posture, the same gating `DEVBENCH_DATA_DIR` gets in main.rs.
pub fn default_store(data_dir: &Path) -> Arc<dyn SecretStore> {
    #[cfg(debug_assertions)]
    {
        eprintln!(
            "debug build: secrets in {} rather than the OS keychain (ad-hoc signatures re-prompt on every rebuild)",
            data_dir.join("dev-secrets.json").display()
        );
        Arc::new(FileSecretStore::new(data_dir))
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = data_dir;
        Arc::new(KeyringSecretStore)
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

    #[test]
    fn file_store_round_trips_and_clears() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileSecretStore::new(dir.path());
        assert_eq!(store.get("anthropic").unwrap(), None);
        store.set("anthropic", "sk-ant-test").unwrap();
        assert_eq!(store.get("anthropic").unwrap().as_deref(), Some("sk-ant-test"));
        store.clear("anthropic").unwrap();
        assert_eq!(store.get("anthropic").unwrap(), None);
    }

    // One account's write must not drop another's — the whole map is
    // rewritten on every set, so this is the failure mode to pin.
    #[test]
    fn file_store_keeps_other_accounts_when_one_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileSecretStore::new(dir.path());
        store.set("db-connection:default", "pg-pass").unwrap();
        store.set("anthropic", "sk-ant-test").unwrap();
        store.clear("anthropic").unwrap();
        assert_eq!(store.get("db-connection:default").unwrap().as_deref(), Some("pg-pass"));
    }

    #[test]
    fn file_store_survives_a_missing_file_and_writes_owner_only() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileSecretStore::new(dir.path());
        assert!(store.clear("never-set").is_ok());
        store.set("a", "b").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join("dev-secrets.json"))
                .unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "a file holding real passwords must be owner-only");
        }
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
