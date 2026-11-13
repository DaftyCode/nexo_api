//! Messages as they travel: one JSON object per line, UTF-8.
//!
//! - request: `{"id": 1, "method": "execute", "params": {…}}`
//! - response: `{"id": 1, "result": {…}}` or `{"id": 1, "error": {"code", "message"}}`
//! - notification: `{"method": "log", "params": {…}}`, never answered
use crate::{DriverError, Result};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufRead, AsyncBufReadExt};

/// The longest line read: a page of results (16 MiB) with room for its envelope. A peer
/// that sends more is not speaking the protocol and the connection ends.
pub const MAX_LINE: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub enum Message {
    Request {
        id: u64,
        method: String,
        params: Value,
    },
    Response {
        id: u64,
        outcome: Result<Value>,
    },
    Notification {
        method: String,
        params: Value,
    },
}
impl Message {
    /// Reads one line. The error says why it is not a message.
    pub fn parse(line: &str) -> std::result::Result<Self, String> {
        let mut object: Map<String, Value> =
            serde_json::from_str(line).map_err(|error| format!("not a JSON object: {error}"))?;
        let id = match object.remove("id") {
            Some(id) => Some(id.as_u64().ok_or("the id is not a positive integer")?),
            None => None,
        };
        let params = object.remove("params").unwrap_or(Value::Null);
        if let Some(method) = object.remove("method") {
            let method = method
                .as_str()
                .ok_or("the method is not a string")?
                .to_owned();
            return Ok(match id {
                Some(id) => Self::Request { id, method, params },
                None => Self::Notification { method, params },
            });
        }
        let id = id.ok_or("neither a method nor an id")?;
        let outcome = match (object.remove("error"), object.remove("result")) {
            (Some(error), _) => Err(serde_json::from_value::<DriverError>(error)
                .map_err(|error| format!("not an error: {error}"))?),
            (None, Some(result)) => Ok(result),
            (None, None) => return Err("a response without result or error".into()),
        };
        Ok(Self::Response { id, outcome })
    }
    /// The message as its line, without the line break.
    pub fn to_line(&self) -> String {
        match self {
            Self::Request { id, method, params } => {
                json!({"id": id, "method": method, "params": params})
            }
            Self::Response {
                id,
                outcome: Ok(result),
            } => json!({"id": id, "result": result}),
            Self::Response {
                id,
                outcome: Err(error),
            } => json!({"id": id, "error": error}),
            Self::Notification { method, params } => json!({"method": method, "params": params}),
        }
        .to_string()
    }
}

/// Reads the next line into `line`, without its line break. `Ok(false)` at the end of the
/// input; an error when the line is longer than [`MAX_LINE`].
pub async fn read_line<R>(reader: &mut R, line: &mut Vec<u8>) -> std::io::Result<bool>
where
    R: AsyncBufRead + Unpin,
{
    line.clear();
    loop {
        let (used, complete) = {
            let available = reader.fill_buf().await?;
            if available.is_empty() {
                return Ok(!line.is_empty());
            }
            match available.iter().position(|byte| *byte == b'\n') {
                Some(end) => {
                    line.extend_from_slice(&available[..end]);
                    (end + 1, true)
                }
                None => {
                    line.extend_from_slice(available);
                    (available.len(), false)
                }
            }
        };
        reader.consume(used);
        if line.len() > MAX_LINE {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "a message is longer than the protocol allows",
            ));
        }
        if complete {
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return Ok(true);
        }
    }
}
