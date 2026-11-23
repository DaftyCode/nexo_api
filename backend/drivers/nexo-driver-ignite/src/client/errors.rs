//! The errors Ignite answers (`IgniteException`: a trace id, a code of its group and number,
//! the class, the message and the server's stack trace) as the SDK's, by group: SQL parse and
//! validation as syntax, authentication, cancelled statements, lock timeouts, connections.
use crate::msgpack::Reader;
use nexo_driver_sdk::{DriverError, ErrorCode, Result};

const COMMON: i64 = 1;
const CLIENT: i64 = 3;
const SQL: i64 = 4;
const TX: i64 = 7;
const NETWORK: i64 = 11;
const AUTHENTICATION: i64 = 15;

/// The code of the SDK for one of Ignite's (`group << 16 | number`).
pub fn code(ignite: i64) -> ErrorCode {
    let (group, number) = (ignite >> 16, ignite & 0xffff);
    match (group, number) {
        (AUTHENTICATION, _) => ErrorCode::Auth,
        // A schema or a table that is not there, a statement that does not parse or check.
        (SQL, 2..=4) => ErrorCode::Syntax,
        (SQL, 6) => ErrorCode::Cancelled,
        (SQL, _) | (2 | 6 | 10 | 17, _) => ErrorCode::Invalid,
        // A lock not acquired in time.
        (TX, 5) => ErrorCode::Timeout,
        (TX, _) => ErrorCode::Invalid,
        (CLIENT, 1) | (COMMON, 5) | (NETWORK, _) => ErrorCode::Network,
        _ => ErrorCode::Internal,
    }
}

/// The message without the code and the trace id Ignite writes before it
/// (`IGN-SQL-3 TraceId:… Failed to parse query`).
pub fn message(text: &str) -> String {
    let text = text.trim();
    let rest = match text.strip_prefix("IGN-") {
        Some(rest) => rest.split_once(' ').map_or("", |(_, rest)| rest),
        None => return text.to_owned(),
    };
    let rest = match rest.strip_prefix("TraceId:") {
        Some(rest) => rest.split_once(' ').map_or("", |(_, rest)| rest),
        None => rest,
    };
    rest.trim().to_owned()
}

/// Reads an error of an answer.
pub fn read(reader: &mut Reader) -> Result<DriverError> {
    reader.uuid()?;
    let ignite = reader.int()?;
    let class = reader.str()?;
    let text = reader.opt_str()?.unwrap_or_default();
    // The stack trace, which the server sends only when it is told to: not shown.
    if !reader.nil()? {
        reader.skip()?;
    }
    let text = message(&text);
    let text = if text.is_empty() {
        class
            .rsplit('.')
            .next()
            .unwrap_or("Ignite failed")
            .to_owned()
    } else {
        text
    };
    Ok(DriverError::new(code(ignite), text))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::msgpack::Writer;

    #[test]
    fn errors_keep_their_meaning() {
        let ignite = |group: i64, number: i64| group << 16 | number;
        assert_eq!(code(ignite(SQL, 3)), ErrorCode::Syntax);
        assert_eq!(code(ignite(SQL, 6)), ErrorCode::Cancelled);
        assert_eq!(code(ignite(SQL, 5)), ErrorCode::Invalid);
        assert_eq!(code(ignite(AUTHENTICATION, 2)), ErrorCode::Auth);
        assert_eq!(code(ignite(TX, 5)), ErrorCode::Timeout);
        assert_eq!(code(ignite(TX, 13)), ErrorCode::Invalid);
        assert_eq!(code(ignite(CLIENT, 1)), ErrorCode::Network);
        assert_eq!(code(ignite(17, 1)), ErrorCode::Invalid);
        assert_eq!(code(ignite(CLIENT, 2)), ErrorCode::Internal);
    }

    #[test]
    fn the_message_loses_its_code_and_trace() {
        assert_eq!(
            message("IGN-SQL-3 TraceId:5e1f Failed to parse query: x"),
            "Failed to parse query: x"
        );
        assert_eq!(message("IGN-CMN-65535 Oops"), "Oops");
        assert_eq!(message("plain"), "plain");
    }

    #[test]
    fn an_error_is_read_from_its_answer() {
        let mut bytes = vec![0xd8, 3];
        bytes.extend([0; 16]);
        let mut rest = Writer::default();
        rest.int(SQL << 16 | 3)
            .str("org.apache.ignite.sql.SqlException")
            .str("IGN-SQL-3 TraceId:1 Failed to parse query")
            .str("stack")
            .nil();
        bytes.extend(rest.into_bytes());
        let error = read(&mut Reader::new(&bytes)).unwrap();
        assert_eq!(error.code, ErrorCode::Syntax);
        assert_eq!(error.message, "Failed to parse query");
        let mut bare = vec![0xd8, 3];
        bare.extend([0; 16]);
        let mut rest = Writer::default();
        rest.int(1)
            .str("org.apache.ignite.lang.IgniteException")
            .nil()
            .nil();
        bare.extend(rest.into_bytes());
        let error = read(&mut Reader::new(&bare)).unwrap();
        assert_eq!(error.message, "IgniteException");
        assert_eq!(error.code, ErrorCode::Internal);
    }
}
