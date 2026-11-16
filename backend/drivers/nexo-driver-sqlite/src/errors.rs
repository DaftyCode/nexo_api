//! SQLite's errors as the driver protocol answers them: a stable code from SQLite's own, the
//! reason the authorizer refused a statement, and where a syntax error is, as a line and a
//! column of the statement.
use crate::guard::Guard;
use nexo_driver_sdk::{DriverError, ErrorCode};
use rusqlite::{Error, ErrorCode as Code, ffi};
use serde_json::{Map, json};
use std::path::Path;

/// The line and the column (from 1, in characters) of a byte of a statement.
pub(crate) fn position(sql: &str, offset: usize) -> (usize, usize) {
    let mut at = offset.min(sql.len());
    while !sql.is_char_boundary(at) {
        at -= 1;
    }
    let before = &sql[..at];
    let line = before.matches('\n').count() + 1;
    let start = before.rfind('\n').map_or(0, |newline| newline + 1);
    (line, before[start..].chars().count() + 1)
}

/// The code of a SQLite failure: `prepared` says whether the statement failed while it was
/// read (a wrong name or word is then a syntax error) rather than while it ran.
fn code_of(code: Code, prepared: bool) -> ErrorCode {
    match code {
        Code::AuthorizationForStatementDenied | Code::ReadOnly | Code::PermissionDenied => {
            ErrorCode::Permission
        }
        Code::OperationInterrupted => ErrorCode::Cancelled,
        Code::DatabaseBusy | Code::DatabaseLocked => ErrorCode::Timeout,
        Code::NotADatabase | Code::CannotOpen | Code::DatabaseCorrupt => ErrorCode::Invalid,
        Code::Unknown if prepared => ErrorCode::Syntax,
        _ => ErrorCode::Invalid,
    }
}

/// A driver error from a SQLite error of a statement (`sql`, when there is one).
pub(crate) fn database(
    error: Error,
    sql: Option<&str>,
    guard: &Guard,
    prepared: bool,
) -> DriverError {
    let (failure, message, offset) = match error {
        Error::SqliteFailure(failure, message) => (failure, message, None),
        Error::SqlInputError {
            error, msg, offset, ..
        } => (error, Some(msg), usize::try_from(offset).ok()),
        Error::MultipleStatement => {
            return DriverError::invalid("Run one statement at a time");
        }
        Error::InvalidParameterCount(given, wanted) => {
            return DriverError::invalid(format!(
                "The statement takes {wanted} parameters and was given {given}"
            ));
        }
        other => return DriverError::internal(other.to_string()),
    };
    let mut code = code_of(failure.code, prepared);
    let mut text = message.unwrap_or_else(|| failure.to_string());
    if failure.code == Code::OperationInterrupted && guard.timed_out() {
        code = ErrorCode::Timeout;
        text = "The statement ran past its time limit".into();
    } else if failure.code == Code::OperationInterrupted {
        text = "The statement was cancelled".into();
    }
    // The authorizer refused what the statement does (a function is refused as a plain
    // error): its reason says why.
    if let Some(reason) = guard.refused() {
        code = ErrorCode::Permission;
        text = reason.into();
    }
    let mut detail = Map::new();
    detail.insert("code".into(), json!(failure.extended_code));
    if let (Some(sql), Some(offset)) = (sql, offset) {
        let (line, column) = position(sql, offset);
        detail.insert("line".into(), json!(line));
        detail.insert("column".into(), json!(column));
    }
    DriverError::new(code, text).with_detail(detail.into())
}

/// What opening a file gives when it is not a database, cannot be opened or is locked.
pub(crate) fn opening(error: Error, path: &Path, guard: Option<&Guard>) -> DriverError {
    let shown = path.display();
    match &error {
        Error::SqliteFailure(failure, _) if failure.code == Code::NotADatabase => {
            DriverError::invalid(format!("{shown} is not a SQLite database"))
        }
        Error::SqliteFailure(failure, _) if failure.code == Code::CannotOpen => {
            DriverError::invalid(format!("{shown} cannot be opened: {error}"))
        }
        Error::SqliteFailure(failure, _) if failure.extended_code == ffi::SQLITE_READONLY => {
            DriverError::permission(format!("{shown} can only be read: {error}"))
        }
        _ => match guard {
            Some(guard) => database(error, None, guard, false),
            None => DriverError::invalid(format!("{shown}: {error}")),
        },
    }
}

pub(crate) fn no_cursor() -> DriverError {
    DriverError::invalid("The cursor is closed or does not exist")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn says_where_a_byte_is() {
        assert_eq!(position("SELECT 1 +", 10), (1, 11));
        assert_eq!(position("SELECT 1,\n  2 FORM t", 17), (2, 8));
        assert_eq!(position("SELECT 'año' x", 13), (1, 13));
    }
}
