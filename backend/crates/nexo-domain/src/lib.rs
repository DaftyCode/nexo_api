//! Framework-free domain: documents, workspaces, invariants and errors.
//!
//! Nexo runs for the single person who opens it, on their own computer. There are no
//! accounts: access is protected by the local session, see `nexo-http`.
pub mod hosts;
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

/// Kinds of documents stored in a workspace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DocumentKind {
    Collection,
    Environment,
    Globals,
    History,
    Run,
    Mock,
    Dataset,
    Api,
    Monitor,
    Comment,
    Settings,
}
impl DocumentKind {
    pub const ALL: [DocumentKind; 11] = [
        Self::Collection,
        Self::Environment,
        Self::Globals,
        Self::History,
        Self::Run,
        Self::Mock,
        Self::Dataset,
        Self::Api,
        Self::Monitor,
        Self::Comment,
        Self::Settings,
    ];
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Collection => "collection",
            Self::Environment => "environment",
            Self::Globals => "globals",
            Self::History => "history",
            Self::Run => "run",
            Self::Mock => "mock",
            Self::Dataset => "dataset",
            Self::Api => "api",
            Self::Monitor => "monitor",
            Self::Comment => "comment",
            Self::Settings => "settings",
        }
    }
    pub fn parse(value: &str) -> Result<Self> {
        Self::ALL
            .into_iter()
            .find(|kind| kind.as_str() == value)
            .ok_or_else(|| Error::Validation("Unknown resource kind".into()))
    }
    /// History entries and run reports never change after they are written.
    pub fn keeps_revisions(self) -> bool {
        !matches!(self, Self::History | Self::Run)
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
        Ok(())
    }
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

/// Engine operations the interface may request.
#[cfg(test)]
mod tests {
    use super::*;
    fn document(kind: DocumentKind, value: Value) -> Document {
        Document {
            id: DocumentId::parse("a").unwrap(),
            workspace_id: WorkspaceId::parse("w").unwrap(),
            kind,
            name: "a".into(),
            revision: 0,
            updated_at: 0,
            value,
        }
    }
    #[test]
    fn document_kinds_round_trip() {
        for kind in DocumentKind::ALL {
            assert_eq!(DocumentKind::parse(kind.as_str()).unwrap(), kind);
            let json = serde_json::to_string(&kind).unwrap();
            assert_eq!(json, format!("\"{}\"", kind.as_str()));
        }
        assert!(DocumentKind::parse("executable").is_err());
        assert!(serde_json::from_str::<DocumentKind>("\"executable\"").is_err());
        assert!(!DocumentKind::History.keeps_revisions());
    }
    #[test]
    fn collections_need_items() {
        assert!(
            document(DocumentKind::Collection, serde_json::json!({}))
                .validate()
                .is_err()
        );
        assert!(
            document(DocumentKind::Collection, serde_json::json!({"item": []}))
                .validate()
                .is_ok()
        );
        for kind in [DocumentKind::Environment, DocumentKind::Globals] {
            assert!(
                document(kind, serde_json::json!({"name": "x"}))
                    .validate()
                    .is_err()
            );
            assert!(
                document(kind, serde_json::json!({"values": []}))
                    .validate()
                    .is_ok()
            );
        }
    }
    #[test]
    fn identifiers_reject_invalid_values() {
        assert!(DocumentId::parse("").is_err());
        assert!(DocumentId::parse("a\u{0}b").is_err());
        assert!(DocumentId::parse("x".repeat(161)).is_err());
        assert!(serde_json::from_str::<DocumentId>("\"ok\"").is_ok());
        assert!(serde_json::from_str::<DocumentId>("\"\"").is_err());
    }
    #[test]
    fn no_arbitrary_engine_dispatch() {}
}
