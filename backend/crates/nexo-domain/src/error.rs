//! The errors of the domain, as every layer reports them.
use serde_json::Value;

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
    /// A database refused or failed a statement. `code` is stable (`syntax`, `auth`,
    /// `cancelled`…) and `detail` says more, such as the position of a syntax error.
    #[error("{message}")]
    Database {
        code: String,
        message: String,
        detail: Option<Value>,
    },
}
pub type Result<T> = std::result::Result<T, Error>;
