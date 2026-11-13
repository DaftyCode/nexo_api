//! What a driver answers when it cannot do what it was asked, with a stable code the
//! interface translates.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ErrorCode {
    /// The server refused the user or the password.
    Auth,
    /// The server cannot be reached, or the egress policy does not allow it.
    Network,
    Tls,
    /// The statement is not valid for the server.
    Syntax,
    /// The user may not do this on the server.
    Permission,
    Timeout,
    Cancelled,
    /// The driver, or its database engine, does not have this.
    Unsupported,
    /// The request itself is wrong: a missing field, an unknown connection or cursor.
    Invalid,
    /// The driver process stopped, or its connection was closed.
    Closed,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DriverError {
    pub code: ErrorCode,
    pub message: String,
    /// What the server said besides the message, such as the position of a syntax error.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<Value>,
}
pub type Result<T> = std::result::Result<T, DriverError>;

macro_rules! constructors {
    ($($name:ident => $code:ident),* $(,)?) => {$(
        pub fn $name(message: impl Into<String>) -> Self {
            Self::new(ErrorCode::$code, message)
        }
    )*};
}
impl DriverError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            detail: None,
        }
    }
    constructors! {
        auth => Auth, network => Network, tls => Tls, syntax => Syntax,
        permission => Permission, timeout => Timeout, cancelled => Cancelled,
        unsupported => Unsupported, invalid => Invalid, closed => Closed,
        internal => Internal,
    }
    pub fn with_detail(mut self, detail: Value) -> Self {
        self.detail = Some(detail);
        self
    }
}
impl std::fmt::Display for DriverError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}
impl std::error::Error for DriverError {}
