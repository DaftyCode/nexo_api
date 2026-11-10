//! GraphQL subscriptions over Server-Sent Events: the "distinct connections" mode of the
//! `graphql-sse` protocol. The operation is POSTed with `Accept: text/event-stream`; the
//! server answers each result as a `next` event and ends with `complete`. Closing the
//! connection ends the subscription.
//!
//! Only the reading of the stream is here, so it can be tested without a network; `realtime`
//! runs it.
use serde_json::{Value, json};

/// The name the interface gives this protocol, next to the WebSocket ones.
pub const NAME: &str = "graphql-sse";

pub fn is_sse(name: Option<&str>) -> bool {
    name == Some(NAME)
}

/// One event of a `text/event-stream`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Event {
    /// `message` when the server names none, as in the EventSource standard.
    pub name: String,
    pub data: String,
}

/// Reads the events of a stream from its chunks, which may split lines and characters.
#[derive(Default)]
pub struct Parser {
    pending: Vec<u8>,
    name: String,
    data: Vec<String>,
}
impl Parser {
    /// The events this chunk completes.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<Event> {
        self.pending.extend_from_slice(chunk);
        let mut events = Vec::new();
        while let Some(end) = self.pending.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=end).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim_end_matches(['\n', '\r']);
            if line.is_empty() {
                if !self.data.is_empty() || !self.name.is_empty() {
                    events.push(Event {
                        name: if self.name.is_empty() {
                            "message".into()
                        } else {
                            std::mem::take(&mut self.name)
                        },
                        data: std::mem::take(&mut self.data).join("\n"),
                    });
                }
                continue;
            }
            // A comment, such as a keep-alive.
            if line.starts_with(':') {
                continue;
            }
            let (field, value) = line.split_once(':').unwrap_or((line, ""));
            let value = value.strip_prefix(' ').unwrap_or(value);
            match field {
                "event" => self.name = value.to_string(),
                "data" => self.data.push(value.to_string()),
                // `id` and `retry` matter only to reconnect, which a subscription does not.
                _ => {}
            }
        }
        events
    }
}

/// What an event means for the subscription.
#[derive(Clone, Debug, PartialEq)]
pub enum Incoming {
    /// A result: `next`, or an unnamed event.
    Next(Value),
    /// The server ended the subscription.
    Complete,
    /// Anything else, shown as it came.
    Other(Value),
}
pub fn interpret(event: Event) -> Incoming {
    match event.name.as_str() {
        "complete" => Incoming::Complete,
        "next" | "message" => {
            Incoming::Next(serde_json::from_str(&event.data).unwrap_or(Value::String(event.data)))
        }
        _ => Incoming::Other(json!({"event": event.name, "data": event.data})),
    }
}

/// The JSON body of the request: query, variables and operation name.
pub fn body(operation: &crate::graphql_ws::Operation) -> String {
    operation.payload().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_are_read_across_chunks_lines_and_characters() {
        let mut parser = Parser::default();
        let stream = "event: next\ndata: {\"data\":{\"tick\":1}}\n\n: keep-alive\n\nevent: next\r\ndata: {\"data\":\r\ndata: {\"word\":\"año\"}}\r\n\r\ndata: plain\n\nevent: complete\ndata:\n\n";
        let bytes = stream.as_bytes();
        // One byte at a time: "ñ" arrives split in two.
        let events: Vec<Event> = bytes.iter().flat_map(|b| parser.push(&[*b])).collect();
        assert_eq!(
            events,
            vec![
                Event {
                    name: "next".into(),
                    data: "{\"data\":{\"tick\":1}}".into()
                },
                Event {
                    name: "next".into(),
                    data: "{\"data\":\n{\"word\":\"año\"}}".into()
                },
                Event {
                    name: "message".into(),
                    data: "plain".into()
                },
                Event {
                    name: "complete".into(),
                    data: String::new()
                },
            ]
        );
        // Unknown fields and a line without a colon are ignored.
        assert_eq!(
            Parser::default().push(b"id: 7\nretry: 10\ndata\nevent: ping\n\n"),
            vec![Event {
                name: "ping".into(),
                data: String::new()
            }]
        );
        assert!(Parser::default().push(b"\n\n").is_empty());
    }

    #[test]
    fn events_become_results_completion_or_messages() {
        let event = |name: &str, data: &str| Event {
            name: name.into(),
            data: data.into(),
        };
        assert_eq!(
            interpret(event("next", "{\"data\":{\"a\":1}}")),
            Incoming::Next(json!({"data": {"a": 1}}))
        );
        assert_eq!(
            interpret(event("message", "text")),
            Incoming::Next(json!("text"))
        );
        assert_eq!(interpret(event("complete", "")), Incoming::Complete);
        assert_eq!(
            interpret(event("ping", "x")),
            Incoming::Other(json!({"event": "ping", "data": "x"}))
        );
        assert!(is_sse(Some("graphql-sse")));
        assert!(!is_sse(Some("graphql-ws")));
        assert!(!is_sse(None));
        let operation = crate::graphql_ws::Operation::from_payload(
            &json!({"query": "subscription { tick }", "operationName": "Ticks"}),
        )
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&body(&operation)).unwrap(),
            json!({"query": "subscription { tick }", "variables": {}, "operationName": "Ticks"})
        );
    }
}
