//! The connection a session opens: the saved one, with the values of the environment
//! variables it names and its vault references resolved.
use crate::{
    Application,
    ports::{SqlConnection, SqlTls},
    vault::{replace_vault, vault_references},
};
use nexo_domain::{
    Document, DocumentId, DocumentKind, Error, Result, WorkspaceId, hosts::AllowedHosts,
};
use serde_json::Value;
use std::collections::BTreeMap;

/// Replaces each `{{name}}` that is not a vault reference with the value of that variable,
/// in every text of `value`. A variable without a value is named.
pub(crate) fn with_variables(value: &Value, variables: &BTreeMap<String, String>) -> Result<Value> {
    Ok(match value {
        Value::String(text) => {
            let mut out = String::with_capacity(text.len());
            let mut rest = text.as_str();
            while let Some(start) = rest.find("{{") {
                out.push_str(&rest[..start]);
                let Some(end) = rest[start..].find("}}") else {
                    break;
                };
                let inner = rest[start + 2..start + end].trim();
                if inner.starts_with("vault:") {
                    out.push_str(&rest[start..start + end + 2]);
                } else {
                    let value = variables.get(inner).ok_or_else(|| {
                        Error::Validation(format!(
                            "The variable {{{{{inner}}}}} has no value in the active environment"
                        ))
                    })?;
                    out.push_str(value);
                }
                rest = &rest[start + end + 2..];
            }
            out.push_str(rest);
            Value::String(out)
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| with_variables(item, variables))
                .collect::<Result<_>>()?,
        ),
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(name, value)| Ok((name.clone(), with_variables(value, variables)?)))
                .collect::<Result<_>>()?,
        ),
        other => other.clone(),
    })
}

fn text(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(String::from)
}

/// Builds the connection a driver receives from a connection's value, once its variables
/// and vault references are replaced.
fn sql_connection(value: &Value) -> Result<SqlConnection> {
    let port = match value.get("port") {
        Some(Value::Number(port)) => port.as_u64().and_then(|port| u16::try_from(port).ok()),
        Some(Value::String(port)) if !port.trim().is_empty() => Some(
            port.trim()
                .parse()
                .map_err(|_| Error::Validation(format!("The port {port} is not a number")))?,
        ),
        _ => None,
    };
    let tls = value.get("tls").cloned().unwrap_or(Value::Null);
    let options = value
        .get("params")
        .and_then(Value::as_object)
        .map(|params| {
            params
                .iter()
                .filter_map(|(name, value)| Some((name.clone(), value.as_str()?.to_owned())))
                .collect()
        })
        .unwrap_or_default();
    Ok(SqlConnection {
        driver: text(value, "driver").unwrap_or_default(),
        host: text(value, "host"),
        port,
        database: text(value, "database"),
        user: text(value, "user"),
        password: text(value, "password"),
        tls: SqlTls {
            mode: text(&tls, "mode").unwrap_or_else(|| "disable".into()),
            ca_pem: text(&tls, "caPem"),
            cert_pem: text(&tls, "certPem"),
            key_pem: text(&tls, "keyPem"),
        },
        options,
        read_only: value.get("readOnly") == Some(&Value::Bool(true)),
        secret_hosts: Vec::new(),
    })
}

impl Application {
    /// A saved SQL connection of a workspace.
    pub(super) async fn saved_sql_connection(
        &self,
        workspace: &WorkspaceId,
        id: &str,
    ) -> Result<Document> {
        let id = DocumentId::parse(id)?;
        let stored = self.workspaces.document(&id).await?;
        let sql = stored
            .value
            .get("driver")
            .and_then(Value::as_str)
            .is_some_and(|driver| driver != "mongodb");
        if stored.kind != DocumentKind::Connection || &stored.workspace_id != workspace || !sql {
            return Err(Error::Validation(
                "Choose a saved database connection of this workspace".into(),
            ));
        }
        Ok(stored)
    }

    /// The connection a driver receives, from a connection's value: variables replaced, the
    /// vault values in `values` (to keep them out of every answer) and the allowed domains of
    /// those secrets alongside.
    pub(super) async fn resolve_sql_connection(
        &self,
        value: &Value,
        variables: &BTreeMap<String, String>,
        values: &mut Vec<(String, String)>,
    ) -> Result<SqlConnection> {
        let value = with_variables(value, variables)?;
        let names = vault_references(&value);
        for name in &names {
            values.push((name.clone(), self.secrets.resolve(name).await?));
        }
        let resolve = |text: Value| match text {
            Value::String(text) => Value::String(replace_vault(&text, values, false)),
            other => other,
        };
        let mut value = value;
        for field in ["host", "database", "user", "password"] {
            if let Some(text) = value.get_mut(field) {
                *text = resolve(text.take());
            }
        }
        if let Some(tls) = value.get_mut("tls").and_then(Value::as_object_mut) {
            for text in tls.values_mut() {
                *text = resolve(text.take());
            }
        }
        if let Some(params) = value.get_mut("params").and_then(Value::as_object_mut) {
            for text in params.values_mut() {
                *text = resolve(text.take());
            }
        }
        let mut connection = sql_connection(&value)?;
        if !names.is_empty() {
            connection.secret_hosts = self
                .secrets
                .secrets()
                .await?
                .into_iter()
                .filter(|secret| names.contains(&secret.name) && !secret.allowed_hosts.is_empty())
                .map(|secret| (secret.name, AllowedHosts::stored(&secret.allowed_hosts)))
                .collect();
        }
        Ok(connection)
    }
}
