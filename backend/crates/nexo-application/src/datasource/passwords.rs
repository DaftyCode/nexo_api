//! The password of a connection that keeps none in the vault (DB-25): asked for when one of
//! its sessions opens (and kept in memory while any of them is open), or read from the user's
//! PostgreSQL pgpass file when the connection says so. Shell commands that give a password
//! (DBeaver's) are left out on purpose: they would run anything.
use crate::{Application, ports::SqlConnection};
use nexo_domain::{Error, Result, sql::pgpass_password};
use serde_json::{Value, json};

/// Where a connection's password comes from, when not from the vault.
pub(crate) enum Source {
    Vault,
    Asked,
    Pgpass,
}
impl Source {
    pub(crate) fn of(value: &Value) -> Self {
        if value.get("askPassword") == Some(&Value::Bool(true)) {
            Self::Asked
        } else if value.get("pgpass") == Some(&Value::Bool(true)) {
            Self::Pgpass
        } else {
            Self::Vault
        }
    }
}

impl Application {
    /// Gives `connection` its password when the vault does not keep it: the one `typed` now,
    /// or the one typed for another session of it still open, or pgpass's. Its value joins
    /// `values`, so it never comes back in an answer or an error.
    pub(crate) async fn supply_password(
        &self,
        source: &Source,
        remembered: Option<String>,
        typed: Option<String>,
        connection: &mut SqlConnection,
        values: &mut Vec<(String, String)>,
    ) -> Result<()> {
        let password = match source {
            Source::Vault => return Ok(()),
            Source::Asked => typed.or(remembered).ok_or_else(|| Error::Database {
                code: "password".into(),
                message: "Type the password of the connection".into(),
                detail: None,
            })?,
            Source::Pgpass => self.pgpass_password(connection).await?,
        };
        values.push(("password".into(), password.clone()));
        connection.password = Some(password);
        Ok(())
    }

    /// The line of the user's pgpass file for the connection's server, database and user.
    async fn pgpass_password(&self, connection: &SqlConnection) -> Result<String> {
        let files = self
            .user_files
            .as_ref()
            .ok_or_else(|| Error::Unavailable("The pgpass file cannot be read here".into()))?;
        let text = files
            .pgpass()
            .await?
            .ok_or_else(|| Error::Validation("There is no pgpass file for this user".into()))?;
        let host = connection
            .host
            .clone()
            .unwrap_or_else(|| "localhost".into());
        let port = connection.port.unwrap_or(5432);
        let user = connection.user.clone().unwrap_or_default();
        // As libpq: the database is the user's name when the connection names none.
        let database = connection.database.clone().unwrap_or_else(|| user.clone());
        pgpass_password(&text, &host, port, &database, &user).ok_or_else(|| {
            Error::Validation(format!(
                "The pgpass file has no line for {host}:{port}, database {database} as {user}"
            ))
        })
    }
}

/// What an error asking for the password carries, for the interface to ask it.
pub(super) fn asking(error: Error, name: &str) -> Error {
    match error {
        Error::Database { code, message, .. } if code == "password" => Error::Database {
            code,
            message,
            detail: Some(json!({ "connection": name })),
        },
        other => other,
    }
}
