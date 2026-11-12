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
    let operation = Operation::from_payload(&json!({"query": "subscription { ticks }"})).unwrap();
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
    assert!(error(json!({"query": "s", "connectionParams": 3})).contains("Connection parameters"));
    assert!(Protocol::from_name(Some("sse")).is_err());
    let blank =
        Operation::from_payload(&json!({"query": "s", "variables": "", "operationName": " "}))
            .unwrap();
    assert_eq!(
        (blank.variables, blank.operation_name),
        (serde_json::json!({}), None)
    );
}
