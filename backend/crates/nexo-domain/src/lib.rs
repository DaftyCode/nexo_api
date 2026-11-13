//! Framework-free domain: documents, workspaces, invariants and errors.
//!
//! Nexo runs for the single person who opens it, on their own computer. There are no
//! accounts: access is protected by the local session, see `nexo-http`.

mod kind;
pub use kind::DocumentKind;

pub mod diff;
pub mod hosts;
pub mod schema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Validation(String),
    #[error("Open Nexo from its launcher to start a session")]
    Unauthorized,
    #[error("Resource not found")]
    NotFound,
    #[error("Resource changed since it was opened; reload before saving")]
    Conflict,
    #[error("{0}")]
    Unavailable(String),
    #[error("{0}")]
    Infrastructure(String),
}
pub type Result<T> = std::result::Result<T, Error>;

macro_rules! identifier {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);
        impl TryFrom<String> for $name {
            type Error = Error;
            fn try_from(value: String) -> Result<Self> {
                Self::parse(value)
            }
        }
        impl From<$name> for String {
            fn from(value: $name) -> String {
                value.0
            }
        }
        impl $name {
            /// Accepts 1-160 characters without control characters.
            pub fn parse(value: impl Into<String>) -> Result<Self> {
                let value = value.into();
                if value.is_empty() || value.len() > 160 || value.chars().any(char::is_control) {
                    return Err(Error::Validation(concat!("Invalid ", stringify!($name)).into()));
                }
                Ok(Self(value))
            }
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }
        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }
    };
}
identifier!(
    /// Identifier of a workspace, a folder that groups documents.
    WorkspaceId
);
identifier!(
    /// Identifier of a document. Clients generate UUIDs.
    DocumentId
);

/// A workspace separates projects of the same person.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: WorkspaceId,
    pub name: String,
}
impl Workspace {
    pub fn validate_name(name: &str) -> Result<String> {
        let name = name.trim();
        if name.is_empty() || name.len() > 200 {
            return Err(Error::Validation(
                "A workspace name between 1 and 200 characters is required".into(),
            ));
        }
        Ok(name.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Document {
    pub id: DocumentId,
    pub workspace_id: WorkspaceId,
    pub kind: DocumentKind,
    pub name: String,
    #[serde(default)]
    pub revision: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub value: Value,
}
impl Document {
    /// The id of the session of a workspace: one per workspace, saved over each time.
    pub fn session_id(workspace: &WorkspaceId) -> String {
        format!("session-{workspace}")
    }
    pub fn validate(&self) -> Result<()> {
        if self.name.trim().is_empty() || self.name.len() > 500 {
            return Err(Error::Validation(
                "A name between 1 and 500 characters is required".into(),
            ));
        }
        if self.kind == DocumentKind::Collection
            && !self.value.get("item").is_some_and(Value::is_array)
        {
            return Err(Error::Validation("A collection needs an item list".into()));
        }
        if matches!(self.kind, DocumentKind::Environment | DocumentKind::Globals)
            && !self.value.get("values").is_some_and(Value::is_array)
        {
            return Err(Error::Validation("Variables need a values list".into()));
        }
        if self.kind == DocumentKind::Session {
            if self.id.as_str() != Self::session_id(&self.workspace_id) {
                return Err(Error::Validation(
                    "A workspace keeps one session, with the id of the workspace".into(),
                ));
            }
            if !self.value.get("tabs").is_some_and(Value::is_array) {
                return Err(Error::Validation("A session needs a tab list".into()));
            }
        }
        if self.kind == DocumentKind::Connection {
            let Some(uri) = self.value.get("uri").and_then(Value::as_str) else {
                return Err(Error::Validation("A connection needs a URI".into()));
            };
            if uri_has_password(uri) {
                return Err(Error::Validation(
                    "Keep the password out of the connection URI: Nexo keeps it in the vault"
                        .into(),
                ));
            }
        }
        if matches!(
            self.kind,
            DocumentKind::Query | DocumentKind::QueryHistory | DocumentKind::DatabaseChange
        ) {
            let named = |field: &str| {
                self.value
                    .get(field)
                    .and_then(Value::as_str)
                    .is_some_and(|text| !text.trim().is_empty())
            };
            if !named("database") || !named("collection") {
                return Err(Error::Validation(
                    "A query needs its database and collection".into(),
                ));
            }
        }
        Ok(())
    }
}

/// Whether a connection URI (`scheme://user:password@hosts/…`) carries a password. Template
/// variables (`{{name}}`, `{{vault:name}}`) are not read as one.
pub fn uri_has_password(uri: &str) -> bool {
    let Some((_, rest)) = uri.split_once("://") else {
        return false;
    };
    let authority = rest.split(['/', '?']).next().unwrap_or_default();
    let Some((userinfo, _)) = authority.rsplit_once('@') else {
        return false;
    };
    let mut plain = String::new();
    let mut remaining = userinfo;
    while let Some(start) = remaining.find("{{") {
        plain.push_str(&remaining[..start]);
        match remaining[start..].find("}}") {
            Some(end) => remaining = &remaining[start + end + 2..],
            None => {
                remaining = &remaining[start..];
                break;
            }
        }
    }
    plain.push_str(remaining);
    plain.contains(':')
}

/// Document metadata without its value, for listings.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentSummary {
    pub id: DocumentId,
    pub workspace_id: WorkspaceId,
    pub kind: DocumentKind,
    pub name: String,
    pub revision: i64,
    pub updated_at: i64,
}

/// A vault secret as listings show it: its name and allowed domains, never its value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretSummary {
    pub name: String,
    /// Hosts it may be sent to; empty allows every host.
    pub allowed_hosts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Revision {
    pub revision: i64,
    pub changed_at: i64,
    pub value: Value,
}

#[cfg(test)]
mod tests;
