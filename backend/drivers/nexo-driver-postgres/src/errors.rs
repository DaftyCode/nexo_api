//! PostgreSQL's errors as the driver protocol answers them: a stable code from the SQLSTATE,
//! and the position of the error as a line and a column of the statement.
use nexo_driver_sdk::{DriverError, ErrorCode};
use serde_json::{Map, Value, json};
use tokio_postgres::error::ErrorPosition;

/// The code of a SQLSTATE: its class decides, a few states are more precise.
fn code_of(state: &str) -> ErrorCode {
    match state {
        "57014" => ErrorCode::Cancelled,
        "42501" | "25006" => ErrorCode::Permission,
        "3D000" | "3F000" => ErrorCode::Invalid,
        "57P01" | "57P02" | "57P03" => ErrorCode::Closed,
        _ => match state.get(..2) {
            Some("28") => ErrorCode::Auth,
            Some("42") => ErrorCode::Syntax,
            Some("08") => ErrorCode::Network,
            _ => ErrorCode::Invalid,
        },
    }
}

/// The line and column (from 1) of a character position (from 1) of `sql`.
fn line_and_column(sql: &str, position: usize) -> (usize, usize) {
    let before: String = sql.chars().take(position.saturating_sub(1)).collect();
    let line = before.matches('\n').count() + 1;
    let column = before
        .rsplit('\n')
        .next()
        .map_or(0, |text| text.chars().count())
        + 1;
    (line, column)
}

/// A driver error from a PostgreSQL error, for a statement (`sql`) when there is one.
pub(crate) fn database(error: tokio_postgres::Error, sql: Option<&str>) -> DriverError {
    let Some(db) = error.as_db_error() else {
        let text = error.to_string();
        let debug = format!("{error:?}");
        let code = if error.is_closed() {
            ErrorCode::Closed
        } else if debug.contains("Tls") || text.contains("certificate") {
            ErrorCode::Tls
        } else if debug.contains("Authentication") || text.contains("password") {
            ErrorCode::Auth
        } else if debug.contains("Io") {
            ErrorCode::Network
        } else {
            ErrorCode::Internal
        };
        // The source of the error says what went wrong (a certificate, a refused connection).
        let reason = std::error::Error::source(&error).map(ToString::to_string);
        let message = match reason {
            Some(reason) if !text.contains(&reason) => format!("{text}: {reason}"),
            _ => text,
        };
        return DriverError::new(code, message);
    };
    let state = db.code().code();
    let mut detail = Map::new();
    detail.insert("sqlstate".into(), json!(state));
    for (name, value) in [
        ("detail", db.detail()),
        ("hint", db.hint()),
        ("where", db.where_()),
    ] {
        if let Some(value) = value {
            detail.insert(name.into(), json!(value));
        }
    }
    if let (Some(ErrorPosition::Original(position)), Some(sql)) = (db.position(), sql) {
        let (line, column) = line_and_column(sql, *position as usize);
        detail.insert("position".into(), json!(position));
        detail.insert("line".into(), json!(line));
        detail.insert("column".into(), json!(column));
    }
    DriverError::new(code_of(state), db.message()).with_detail(Value::Object(detail))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn states_become_codes() {
        for (state, code) in [
            ("28P01", ErrorCode::Auth),
            ("42601", ErrorCode::Syntax),
            ("42P01", ErrorCode::Syntax),
            ("42501", ErrorCode::Permission),
            ("57014", ErrorCode::Cancelled),
            ("3D000", ErrorCode::Invalid),
            ("23505", ErrorCode::Invalid),
            ("08006", ErrorCode::Network),
        ] {
            assert_eq!(code_of(state), code, "{state}");
        }
    }

    #[test]
    fn positions_become_lines_and_columns() {
        let sql = "select 1,\n  frm x\nwhere ñ";
        assert_eq!(line_and_column(sql, 1), (1, 1));
        assert_eq!(line_and_column(sql, 13), (2, 3));
        assert_eq!(line_and_column(sql, 25), (3, 7));
    }
}
