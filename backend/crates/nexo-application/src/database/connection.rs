//! The connection a database operation uses: the saved one, with its vault references
//! resolved.
use crate::{
    Application,
    payloads::MongoConnection,
    ports::DatabaseConnection,
    vault::{replace_vault, vault_references},
};
use nexo_domain::{Error, Result, hosts::AllowedHosts};
use serde_json::Value;

/// Whether `text` is `template` with each `{{…}}` replaced by some text, as the interface
/// replaces environment variables.
pub(super) fn matches_template(template: &str, text: &str) -> bool {
    let mut literals = Vec::new();
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        let Some(end) = rest[start..].find("}}") else {
            break;
        };
        literals.push(&rest[..start]);
        rest = &rest[start + end + 2..];
    }
    literals.push(rest);
    if literals.len() == 1 {
        return template == text;
    }
    let (first, last) = (literals[0], literals[literals.len() - 1]);
    if !text.starts_with(first) || !text[first.len()..].ends_with(last) {
        return false;
    }
    let mut middle = &text[first.len()..text.len() - last.len()];
    for literal in &literals[1..literals.len() - 1] {
        match middle.find(literal) {
            Some(index) => middle = &middle[index + literal.len()..],
            None => return false,
        }
    }
    true
}

/// Refuses a connection that is not the saved one: its URI and certificates may only differ
/// by the variables they name, and its secrets must be the saved references.
pub(super) fn check_same(stored: &Value, sent: &MongoConnection) -> Result<()> {
    let field = |name: &str| {
        stored
            .get(name)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
    };
    let same_template = |name: &str, sent: Option<&String>| match (field(name), sent) {
        (None, None) => true,
        (Some(template), Some(text)) => matches_template(template, text.trim()),
        _ => false,
    };
    let same_secret =
        |name: &str, sent: Option<&String>| field(name) == sent.map(|text| text.trim());
    if same_template("uri", Some(&sent.uri))
        && same_template("caPem", sent.ca_pem.as_ref())
        && same_template("certPem", sent.cert_pem.as_ref())
        && same_secret("password", sent.password.as_ref())
        && same_secret("keyPem", sent.key_pem.as_ref())
    {
        Ok(())
    } else {
        Err(Error::Validation(
            "The connection sent is not the saved one: save it before writing".into(),
        ))
    }
}

impl Application {
    /// A connection with its vault references resolved. The values go to `values`, so they
    /// never leave in an error.
    pub(super) async fn resolve_connection(
        &self,
        connection: MongoConnection,
        values: &mut Vec<(String, String)>,
    ) -> Result<DatabaseConnection> {
        let names = vault_references(
            &serde_json::to_value(&connection)
                .map_err(|error| Error::Infrastructure(error.to_string()))?,
        );
        for name in &names {
            values.push((name.clone(), self.secrets.resolve(name).await?));
        }
        let secret_hosts = if names.is_empty() {
            Vec::new()
        } else {
            self.secrets
                .secrets()
                .await?
                .into_iter()
                .filter(|secret| names.contains(&secret.name) && !secret.allowed_hosts.is_empty())
                .map(|secret| {
                    let hosts = AllowedHosts::stored(&secret.allowed_hosts);
                    (secret.name, hosts)
                })
                .collect()
        };
        let field = |text: Option<String>| text.map(|text| replace_vault(&text, values, false));
        Ok(DatabaseConnection {
            uri: replace_vault(&connection.uri, values, true),
            password: field(connection.password),
            ca_pem: field(connection.ca_pem),
            cert_pem: field(connection.cert_pem),
            key_pem: field(connection.key_pem),
            secret_hosts,
        })
    }
}
