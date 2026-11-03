//! Framework-free domain: aggregate data, actor identity, invariants and errors.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Validation(String),
    #[error("Authentication required")]
    Unauthorized,
    #[error("You do not have permission for this workspace")]
    Forbidden,
    #[error("Resource not found")]
    NotFound,
    #[error("Resource changed since it was opened; reload before saving")]
    Conflict,
    #[error("{0}")]
    Infrastructure(String),
}
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Actor {
    pub id: String,
    pub email: String,
    pub name: String,
}
impl Actor {
    pub fn local() -> Self {
        Self {
            id: "local".into(),
            email: String::new(),
            name: "Local workspace".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Document {
    pub id: String,
    pub workspace_id: String,
    pub kind: String,
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
        if self.id.is_empty() || self.id.len() > 160 || self.workspace_id.is_empty() {
            return Err(Error::Validation(
                "Document and workspace identifiers are required".into(),
            ));
        }
        if self.name.trim().is_empty() || self.name.len() > 500 {
            return Err(Error::Validation(
                "A name between 1 and 500 characters is required".into(),
            ));
        }
        if ![
            "collection",
            "environment",
            "history",
            "run",
            "mock",
            "dataset",
            "api",
            "monitor",
            "comment",
            "settings",
        ]
        .contains(&self.kind.as_str())
        {
            return Err(Error::Validation("Unknown resource kind".into()));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Revision {
    pub revision: i64,
    pub changed_at: i64,
    pub actor_id: String,
    pub value: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Credentials {
    pub email: String,
    pub password: String,
    #[serde(default)]
    pub name: String,
}
impl Credentials {
    pub fn validate(&self) -> Result<()> {
        if !self.email.contains('@') || self.email.len() > 254 {
            return Err(Error::Validation("Enter a valid email address".into()));
        }
        if self.password.len() < 12 || self.password.len() > 1024 {
            return Err(Error::Validation(
                "Password must contain at least 12 characters".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub token: String,
    pub actor: Actor,
    pub expires_at: i64,
}

pub fn validate_operation(operation: &str) -> Result<()> {
    if [
        "request",
        "run",
        "cancel",
        "import",
        "codegen",
        "realtime.connect",
        "realtime.send",
        "realtime.close",
        "realtime.poll",
        "grpc",
        "mock.start",
        "mock.stop",
        "mock.list",
        "dataset.query",
        "dataset.import",
        "dataset.schema",
        "mcp.request",
        "oauth.token",
        "cookies.list",
        "cookies.clear",
        "performance",
        "performance.cancel",
    ]
    .contains(&operation)
    {
        Ok(())
    } else {
        Err(Error::Validation("Unknown execution operation".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unknown_document_kinds() {
        let document = Document {
            id: "a".into(),
            workspace_id: "w".into(),
            kind: "executable".into(),
            name: "a".into(),
            revision: 0,
            updated_at: 0,
            value: Value::Null,
        };
        assert!(document.validate().is_err());
    }
    #[test]
    fn no_arbitrary_engine_dispatch() {
        assert!(validate_operation("shell.exec").is_err());
    }
}
