//! Document database use cases. Reads go straight to the port; writes follow the rules in
//! `writes`. The connection's vault references are resolved here, the allowed domains of
//! those secrets go along to be checked against every server, and their values never come
//! back in an error.
mod admin;
mod aggregate;
mod connection;
mod import;
mod reads;
mod schema;
#[cfg(test)]
mod tests;
mod watch;
mod writes;

use crate::{Application, operations::Operation, vault::redact_error};
use nexo_domain::{Error, Result};
use serde_json::Value;

#[cfg(test)]
pub(crate) use aggregate::written;
#[cfg(test)]
pub(crate) use import::IMPORT_BATCH;
pub use writes::CHANGE_LIMIT;

/// Documents in a page of MongoDB results when the client does not say.
pub(crate) const DATABASE_PAGE: u64 = 50;

/// Reads a payload already checked against its type.
fn read<T: serde::de::DeserializeOwned>(payload: &Value) -> Result<T> {
    serde_json::from_value(payload.clone()).map_err(|error| Error::Validation(error.to_string()))
}

/// Refuses unless `confirm` repeats the name of what is dropped or emptied.
fn confirmed(confirm: Option<&str>, name: &str, what: &str) -> Result<()> {
    if confirm.map(str::trim) != Some(name) {
        return Err(Error::Validation(format!(
            "Type the name of the {what} to confirm: {name}"
        )));
    }
    Ok(())
}

impl Application {
    /// Runs a document database operation and removes the connection's secret values from
    /// its errors.
    pub(crate) async fn database(&self, operation: Operation, payload: Value) -> Result<Value> {
        let mut values = Vec::new();
        let result = if operation.is_database_write() {
            self.database_write(operation, payload, &mut values).await
        } else {
            self.database_read(operation, payload, &mut values).await
        };
        result.map_err(|error| redact_error(error, &values))
    }
}
