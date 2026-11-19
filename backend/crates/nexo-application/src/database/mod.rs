//! Document database use cases. Reads go straight to the port; writes follow the rules in
//! `writes`. The connection's vault references are resolved here, the allowed domains of
//! those secrets go along to be checked against every server, and their values never come
//! back in an error.
mod admin;
mod aggregate;
mod compare;
mod connection;
mod import;
mod reads;
mod schema;
mod scripts;
#[cfg(test)]
mod tests;
mod watch;
mod writes;

use crate::{Application, operations::Operation, vault::redact_error};
use nexo_domain::{Error, Result};
use serde_json::{Map, Value};

#[cfg(test)]
pub(crate) use aggregate::written;
#[cfg(test)]
pub(crate) use import::IMPORT_BATCH;
pub(crate) use scripts::connection as saved_connection;
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

/// The connections of a payload: its `connection` and those of the sides it compares.
fn connections(payload: &mut Value) -> Vec<&mut Map<String, Value>> {
    let mut found = Vec::new();
    if let Value::Object(fields) = payload {
        for (key, value) in fields.iter_mut() {
            let Value::Object(object) = value else {
                continue;
            };
            if key == "connection" {
                found.push(object);
            } else if let Some(Value::Object(connection)) = object.get_mut("connection") {
                found.push(connection);
            }
        }
    }
    found
}

impl Application {
    /// Gives each connection of a payload the SSH profiles its route names, with their
    /// secrets; whatever a client sent there is dropped first.
    async fn route_connections(&self, payload: &mut Value) -> Result<()> {
        let workspace = payload["workspace"].as_str().map(String::from);
        let mut routes = Vec::new();
        for connection in connections(payload) {
            connection.remove("sshProfiles");
            if let Some(route) = connection.get("route") {
                routes.push(route.clone());
            }
        }
        let Some(profiles) = self
            .ssh_profiles(workspace.as_deref(), &Value::Array(routes))
            .await?
        else {
            return Ok(());
        };
        for connection in connections(payload) {
            connection.insert("sshProfiles".into(), profiles.clone());
        }
        Ok(())
    }

    /// Runs a document database operation and removes the connection's secret values from
    /// its errors.
    pub(crate) async fn database(&self, operation: Operation, mut payload: Value) -> Result<Value> {
        self.route_connections(&mut payload).await?;
        let mut values = Vec::new();
        let result = if operation.is_database_write() {
            self.database_write(operation, payload, &mut values).await
        } else {
            self.database_read(operation, payload, &mut values).await
        };
        result.map_err(|error| redact_error(error, &values))
    }
}
