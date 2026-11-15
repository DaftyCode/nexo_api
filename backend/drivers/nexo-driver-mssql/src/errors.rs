//! SQL Server errors as the protocol's codes, with the number, state, class and line the
//! server gives (`detail`).
use nexo_driver_sdk::{DriverError, ErrorCode};
use serde_json::json;

/// The code of a server error, by its number (`sys.messages`).
fn code_of(number: u32) -> ErrorCode {
    match number {
        // Login failed, the password must change, the account is locked or disabled.
        18452 | 18456 | 18470 | 18486 | 18487 | 18488 => ErrorCode::Auth,
        // Incorrect syntax near, missing, unclosed quotation mark, must declare variable.
        102 | 105 | 137 | 156 | 170 | 319 | 1038 => ErrorCode::Syntax,
        // Permission denied, read-only database or secondary.
        229 | 230 | 262 | 297 | 300 | 916 | 3906 | 976 => ErrorCode::Permission,
        // Cannot open the database requested by the login.
        4060 | 911 => ErrorCode::Invalid,
        // Invalid object or column name.
        207 | 208 => ErrorCode::Invalid,
        // The query was cancelled (attention), or killed.
        3617 | 596 => ErrorCode::Cancelled,
        _ => ErrorCode::Internal,
    }
}

/// A tiberius error as the protocol's, with where it happened in the batch.
pub(crate) fn driver_error(error: tiberius::error::Error) -> DriverError {
    use tiberius::error::Error;
    match error {
        Error::Server(token) => DriverError {
            code: code_of(token.code()),
            message: token.message().to_owned(),
            detail: Some(json!({
                "number": token.code(),
                "state": token.state(),
                "class": token.class(),
                "line": token.line(),
                "column": 1,
            })),
        },
        Error::Tls(message) => DriverError::tls(format!("TLS with SQL Server failed: {message}")),
        Error::Io { message, .. } => DriverError::network(format!("SQL Server: {message}")),
        Error::Routing { host, port } => DriverError::network(format!(
            "SQL Server asked to connect to {host}:{port} instead; connect there directly"
        )),
        other => DriverError::internal(other.to_string()),
    }
}

/// A cancelled statement, as the protocol says it.
pub(crate) fn cancelled() -> DriverError {
    DriverError {
        code: ErrorCode::Cancelled,
        message: "The statement was cancelled".into(),
        detail: None,
    }
}

/// A cancelled statement whose session had to connect again to stop it.
pub(crate) fn reopened() -> DriverError {
    DriverError {
        code: ErrorCode::Cancelled,
        message: "The statement was cancelled. To stop it the session connected again: its temporary tables \
                  are gone and an open transaction was rolled back"
            .into(),
        detail: None,
    }
}

/// A cursor that is not open (closed, read to its end, or ended by another statement).
pub(crate) fn no_cursor() -> DriverError {
    DriverError::invalid(
        "The cursor is not open: SQL Server reads one result at a time per session, run it again",
    )
}
