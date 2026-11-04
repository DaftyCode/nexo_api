use crate::infrastructure as err;
use nexo_domain::Result;

/// The vault master key kept in the operating system credential store, created on first use.
pub fn desktop_master_key() -> Result<String> {
    let entry = keyring::Entry::new("Nexo API", "master-key").map_err(err)?;
    match entry.get_password() {
        Ok(value) => Ok(value),
        Err(keyring::Error::NoEntry) => {
            let key = format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            );
            entry.set_password(&key).map_err(err)?;
            Ok(key)
        }
        Err(error) => Err(err(error)),
    }
}
