//! GraphQL subscriptions over WebSocket: the messages of the two protocols servers use.
//!
//! - `graphql-transport-ws` (the `graphql-ws` library, current): `connection_init` →
//!   `connection_ack`, `subscribe`, `next`, `error`, `complete` and `ping`/`pong`.
//! - `graphql-ws` (the legacy `subscriptions-transport-ws` library): `connection_init` →
//!   `connection_ack`, `start`, `data`, `error`, `complete`, `stop`, `ka` and
//!   `connection_terminate`.
//!
//! Only the framing is here, so it can be tested without a network; `realtime` runs it.
use nexo_domain::{Error, Result};
use serde_json::{Map, Value, json};

/// The identifier of the one subscription a connection carries.
pub const SUBSCRIPTION_ID: &str = "1";

/// Which protocol a server speaks, named by its WebSocket subprotocol.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Protocol {
    /// `graphql-transport-ws`.
    Transport,
    /// `graphql-ws` (`subscriptions-transport-ws`).
    Legacy,
}
impl Protocol {
    /// `graphql-transport-ws` unless the legacy one is asked for, as Postman defaults.
    pub fn from_name(name: Option<&str>) -> Result<Self> {
        match name.unwrap_or("graphql-transport-ws") {
            "" | "graphql-transport-ws" => Ok(Self::Transport),
            "graphql-ws" | "subscriptions-transport-ws" => Ok(Self::Legacy),
            other => Err(Error::Validation(format!(
                "Unknown GraphQL subscription protocol {other}"
            ))),
        }
    }
    /// The `Sec-WebSocket-Protocol` to ask for.
    pub fn subprotocol(self) -> &'static str {
        match self {
            Self::Transport => "graphql-transport-ws",
            Self::Legacy => "graphql-ws",
        }
    }
}

/// The operation a subscription sends: query, variables and operation name.
#[derive(Clone, Debug, PartialEq)]
pub struct Operation {
    pub query: String,
    pub variables: Value,
    pub operation_name: Option<String>,
    /// `connection_init` payload, such as an authorization token.
    pub connection_params: Value,
}
impl Operation {
    /// Reads the operation from a `realtime.connect` payload. Variables and connection
    /// parameters may be JSON objects or the JSON text the editor holds.
    pub fn from_payload(payload: &Value) -> Result<Self> {
        let query = payload["query"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_string();
        if query.is_empty() {
            return Err(Error::Validation("Enter the subscription to send".into()));
        }
        Ok(Self {
            query,
            variables: object(&payload["variables"], "GraphQL variables")?,
            operation_name: payload["operationName"]
                .as_str()
                .filter(|name| !name.trim().is_empty())
                .map(String::from),
            connection_params: object(&payload["connectionParams"], "Connection parameters")?,
        })
    }
    fn payload(&self) -> Value {
        let mut payload = json!({"query": self.query, "variables": self.variables});
        if let Some(name) = &self.operation_name {
            payload["operationName"] = json!(name);
        }
        payload
    }
}

/// A JSON object given as an object or as text; empty means none.
fn object(value: &Value, label: &str) -> Result<Value> {
    let parsed = match value {
        Value::Null => return Ok(Value::Object(Map::new())),
        Value::String(text) if text.trim().is_empty() => return Ok(Value::Object(Map::new())),
        Value::String(text) => serde_json::from_str(text)
            .map_err(|error| Error::Validation(format!("{label} must be valid JSON: {error}")))?,
        other => other.clone(),
    };
    if parsed.is_object() {
        Ok(parsed)
    } else {
        Err(Error::Validation(format!("{label} must be a JSON object")))
    }
}

/// The first message: `connection_init`, with the connection parameters when there are any.
pub fn init(operation: &Operation) -> String {
    let empty = operation
        .connection_params
        .as_object()
        .is_none_or(Map::is_empty);
    if empty {
        json!({"type": "connection_init"}).to_string()
    } else {
        json!({"type": "connection_init", "payload": operation.connection_params}).to_string()
    }
}

/// Starts the subscription once the server acknowledged the connection.
pub fn subscribe(protocol: Protocol, operation: &Operation) -> String {
    let kind = match protocol {
        Protocol::Transport => "subscribe",
        Protocol::Legacy => "start",
    };
    json!({"id": SUBSCRIPTION_ID, "type": kind, "payload": operation.payload()}).to_string()
}

/// Ends the subscription before closing: `complete`, or `stop` and `connection_terminate`.
pub fn stop(protocol: Protocol) -> Vec<String> {
    match protocol {
        Protocol::Transport => vec![json!({"id": SUBSCRIPTION_ID, "type": "complete"}).to_string()],
        Protocol::Legacy => vec![
            json!({"id": SUBSCRIPTION_ID, "type": "stop"}).to_string(),
            json!({"type": "connection_terminate"}).to_string(),
        ],
    }
}

/// The answer to a server `ping` (`graphql-transport-ws`).
pub fn pong(payload: &Value) -> String {
    if payload.is_null() {
        json!({"type": "pong"}).to_string()
    } else {
        json!({"type": "pong", "payload": payload}).to_string()
    }
}

/// What a server message means for the connection.
#[derive(Clone, Debug, PartialEq)]
pub enum Incoming {
    /// The connection is accepted: the subscription can start.
    Ack,
    /// A result of the subscription (`next`, `data`).
    Next(Value),
    /// The subscription failed: GraphQL errors, or the legacy `connection_error`.
    Error(Value),
    /// The server ended the subscription.
    Complete,
    /// A `ping` to answer with a `pong`.
    Ping(Value),
    /// Keep-alive and pong messages, with nothing to show.
    Quiet,
    /// A message of no known type, shown as it came.
    Other(Value),
}

/// Reads a server message.
pub fn parse(protocol: Protocol, text: &str) -> Incoming {
    let Ok(message) = serde_json::from_str::<Value>(text) else {
        return Incoming::Other(Value::String(text.to_string()));
    };
    let payload = message.get("payload").cloned().unwrap_or(Value::Null);
    match (protocol, message["type"].as_str().unwrap_or_default()) {
        (_, "connection_ack") => Incoming::Ack,
        (Protocol::Transport, "next") | (Protocol::Legacy, "data") => Incoming::Next(payload),
        (_, "error") | (Protocol::Legacy, "connection_error") => Incoming::Error(payload),
        (_, "complete") => Incoming::Complete,
        (Protocol::Transport, "ping") => Incoming::Ping(payload),
        (Protocol::Transport, "pong") | (Protocol::Legacy, "ka") => Incoming::Quiet,
        _ => Incoming::Other(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn operation() -> Operation {
        Operation::from_payload(&json!({
            "query": "subscription { ticks }",
            "variables": "{\"from\": 1}",
            "operationName": "Ticks",
            "connectionParams": {"authorization": "Bearer t"},
        }))
        .unwrap()
    }
    fn json(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn graphql_transport_ws_messages() {
        let operation = operation();
        let protocol = Protocol::from_name(None).unwrap();
        assert_eq!(protocol.subprotocol(), "graphql-transport-ws");
        assert_eq!(
            json(&init(&operation)),
            serde_json::json!({"type": "connection_init", "payload": {"authorization": "Bearer t"}})
        );
        assert_eq!(
            json(&subscribe(protocol, &operation)),
            serde_json::json!({"id": "1", "type": "subscribe", "payload": {
                "query": "subscription { ticks }", "variables": {"from": 1}, "operationName": "Ticks"
            }})
        );
        assert_eq!(
            stop(protocol).iter().map(|m| json(m)).collect::<Vec<_>>(),
            [serde_json::json!({"id": "1", "type": "complete"})]
        );
        assert_eq!(
            json(&pong(&Value::Null)),
            serde_json::json!({"type": "pong"})
        );
        assert_eq!(
            parse(protocol, r#"{"type":"connection_ack"}"#),
            Incoming::Ack
        );
        assert_eq!(
            parse(
                protocol,
                r#"{"id":"1","type":"next","payload":{"data":{"ticks":1}}}"#
            ),
            Incoming::Next(serde_json::json!({"data": {"ticks": 1}}))
        );
        assert_eq!(
            parse(
                protocol,
                r#"{"id":"1","type":"error","payload":[{"message":"no"}]}"#
            ),
            Incoming::Error(serde_json::json!([{"message": "no"}]))
        );
        assert_eq!(
            parse(protocol, r#"{"id":"1","type":"complete"}"#),
            Incoming::Complete
        );
        assert_eq!(
            parse(protocol, r#"{"type":"ping","payload":{"t":1}}"#),
            Incoming::Ping(serde_json::json!({"t": 1}))
        );
        assert_eq!(parse(protocol, r#"{"type":"pong"}"#), Incoming::Quiet);
        // `data` is not a message of this protocol.
        assert!(matches!(
            parse(protocol, r#"{"type":"data"}"#),
            Incoming::Other(_)
        ));
        assert_eq!(
            parse(protocol, "not json"),
            Incoming::Other(Value::String("not json".into()))
        );
    }

    #[test]
    fn legacy_subscriptions_transport_ws_messages() {
        let protocol = Protocol::from_name(Some("graphql-ws")).unwrap();
        assert_eq!(protocol.subprotocol(), "graphql-ws");
        let operation =
            Operation::from_payload(&json!({"query": "subscription { ticks }"})).unwrap();
        assert_eq!(
            json(&init(&operation)),
            serde_json::json!({"type": "connection_init"})
        );
        assert_eq!(
            json(&subscribe(protocol, &operation)),
            serde_json::json!({"id": "1", "type": "start", "payload": {"query": "subscription { ticks }", "variables": {}}})
        );
        assert_eq!(
            stop(protocol).iter().map(|m| json(m)).collect::<Vec<_>>(),
            [
                serde_json::json!({"id": "1", "type": "stop"}),
                serde_json::json!({"type": "connection_terminate"})
            ]
        );
        assert_eq!(
            parse(
                protocol,
                r#"{"id":"1","type":"data","payload":{"data":{"ticks":2}}}"#
            ),
            Incoming::Next(serde_json::json!({"data": {"ticks": 2}}))
        );
        assert_eq!(parse(protocol, r#"{"type":"ka"}"#), Incoming::Quiet);
        assert_eq!(
            parse(
                protocol,
                r#"{"type":"connection_error","payload":{"message":"denied"}}"#
            ),
            Incoming::Error(serde_json::json!({"message": "denied"}))
        );
        assert!(matches!(
            parse(protocol, r#"{"type":"ping"}"#),
            Incoming::Other(_)
        ));
    }

    #[test]
    fn operations_are_checked() {
        let error = |payload: Value| Operation::from_payload(&payload).unwrap_err().to_string();
        assert!(error(json!({"query": " "})).contains("Enter the subscription"));
        assert!(
            error(json!({"query": "s", "variables": "{"}))
                .contains("GraphQL variables must be valid JSON")
        );
        assert!(error(json!({"query": "s", "variables": "[1]"})).contains("must be a JSON object"));
        assert!(
            error(json!({"query": "s", "connectionParams": 3})).contains("Connection parameters")
        );
        assert!(Protocol::from_name(Some("sse")).is_err());
        let blank =
            Operation::from_payload(&json!({"query": "s", "variables": "", "operationName": " "}))
                .unwrap();
        assert_eq!(
            (blank.variables, blank.operation_name),
            (serde_json::json!({}), None)
        );
    }
}
