//! MySQL's errors as the driver protocol answers them: a stable code from the SQLSTATE and the
//! error number, and where a syntax error is, as a line and a column of the statement.
use mysql_async::{DriverError as MyDriverError, Error, IoError};
use nexo_driver_sdk::{DriverError, ErrorCode};
use serde_json::{Map, Value, json};

/// The code of a server error: its number when it says more than its SQLSTATE.
fn code_of(number: u16, state: &str) -> ErrorCode {
    match number {
        // The statement was interrupted (`KILL QUERY`), or ran past `max_execution_time`.
        1317 => ErrorCode::Cancelled,
        3024 | 1969 => ErrorCode::Timeout,
        1045 | 1698 | 1251 => ErrorCode::Auth,
        1044 | 1142 | 1143 | 1227 | 1370 | 1290 | 1792 | 1836 => ErrorCode::Permission,
        1049 => ErrorCode::Invalid,
        2006 | 2013 | 1053 | 1927 => ErrorCode::Closed,
        _ => match state.get(..2) {
            Some("28") => ErrorCode::Auth,
            Some("42") => ErrorCode::Syntax,
            Some("08") => ErrorCode::Network,
            _ => ErrorCode::Invalid,
        },
    }
}

/// Where a syntax error is: MySQL says `… near 'text' at line N`; the column is where that
/// text starts in the line.
fn position(message: &str, sql: &str) -> Option<(usize, usize)> {
    let at = message.rfind(" at line ")?;
    let line: usize = message[at + 9..]
        .trim_end_matches(|c: char| !c.is_ascii_digit())
        .parse()
        .ok()?;
    let text = sql.lines().nth(line.checked_sub(1)?)?;
    let near = message[..at]
        .find("near '")
        .map(|start| &message[start + 6..at])
        .and_then(|quoted| quoted.strip_suffix('\''))
        .unwrap_or_default();
    let first = near.lines().next().unwrap_or_default();
    let column = if first.is_empty() {
        text.chars().count() + 1
    } else {
        text.find(first)
            .map_or(1, |byte| text[..byte].chars().count() + 1)
    };
    Some((line, column))
}

/// A driver error from a MySQL error, for a statement (`sql`) when there is one.
pub(crate) fn database(error: Error, sql: Option<&str>) -> DriverError {
    match error {
        Error::Server(server) => {
            let mut detail = Map::new();
            detail.insert("sqlstate".into(), json!(server.state));
            detail.insert("number".into(), json!(server.code));
            if let Some((line, column)) = sql.and_then(|sql| position(&server.message, sql)) {
                detail.insert("line".into(), json!(line));
                detail.insert("column".into(), json!(column));
            }
            DriverError::new(code_of(server.code, &server.state), server.message)
                .with_detail(Value::Object(detail))
        }
        Error::Io(IoError::Tls(tls)) => DriverError::tls(format!("TLS failed: {tls}")),
        Error::Io(IoError::Io(io)) => {
            let text = io.to_string();
            let lower = text.to_ascii_lowercase();
            if lower.contains("certificate") || lower.contains("tls") || lower.contains("handshake")
            {
                DriverError::tls(format!("TLS failed: {text}"))
            } else {
                DriverError::network(text)
            }
        }
        Error::Driver(MyDriverError::NoClientSslFlagFromServer) => {
            DriverError::tls("The server does not offer TLS")
        }
        Error::Driver(MyDriverError::ConnectionClosed) => {
            DriverError::closed("The server closed the connection: connect again")
        }
        Error::Driver(MyDriverError::UnknownAuthPlugin { name }) => DriverError::new(
            ErrorCode::Auth,
            format!("The server asks for an authentication Nexo does not have: {name}"),
        ),
        Error::Driver(other) => DriverError::invalid(other.to_string()),
        other => DriverError::internal(other.to_string()),
    }
}

/// A result being read was stopped: the request that comes next ends it.
pub(crate) fn no_cursor() -> DriverError {
    DriverError::invalid("The cursor is not open")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_and_states_become_codes() {
        for (number, state, code) in [
            (1317, "70100", ErrorCode::Cancelled),
            (1045, "28000", ErrorCode::Auth),
            (1064, "42000", ErrorCode::Syntax),
            (1146, "42S02", ErrorCode::Syntax),
            (1142, "42000", ErrorCode::Permission),
            (1792, "25006", ErrorCode::Permission),
            (1062, "23000", ErrorCode::Invalid),
            (2013, "HY000", ErrorCode::Closed),
        ] {
            assert_eq!(code_of(number, state), code, "{number}");
        }
    }

    #[test]
    fn finds_where_a_syntax_error_is() {
        let sql = "SELECT 1,\n  2 FORM t";
        let message = "You have an error in your SQL syntax; check the manual that corresponds to \
                       your MySQL server version for the right syntax to use near 't' at line 2";
        assert_eq!(position(message, sql), Some((2, 10)));
        let end = "… for the right syntax to use near '' at line 1";
        assert_eq!(position(end, "SELECT 1 +"), Some((1, 11)));
        assert_eq!(position("Unknown column 'x'", sql), None);
    }
}
