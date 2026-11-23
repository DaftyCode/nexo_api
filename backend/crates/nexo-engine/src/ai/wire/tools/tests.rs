use super::*;

fn offered() -> Vec<Tool> {
    parse(&json!([
        {"name": "read_open", "description": "What is open", "inputSchema": {"type": "object", "properties": {}}},
        {"name": "sql_query", "description": "Read rows"},
    ]))
    .unwrap()
}

#[test]
fn tools_are_offered_in_each_providers_words() {
    let tools = offered();
    assert_eq!(tools[1].schema, json!({"type": "object", "properties": {}}));
    assert_eq!(
        definitions(Provider::Anthropic, &tools).unwrap()[0],
        json!({"name": "read_open", "description": "What is open", "input_schema": {"type": "object", "properties": {}}})
    );
    assert_eq!(
        definitions(Provider::Local, &tools).unwrap()[1]["function"]["name"],
        "sql_query"
    );
    assert_eq!(
        definitions(Provider::Gemini, &tools).unwrap()[0]["functionDeclarations"][0]["parameters"],
        json!({"type": "object", "properties": {}})
    );
    assert!(definitions(Provider::Openai, &[]).is_none());
    assert!(parse(&Value::Null).unwrap().is_empty());
    assert!(parse(&json!([{"name": "has space"}])).is_err());
    assert!(parse(&json!(vec![json!({"name": "x"}); MAX_TOOLS + 1])).is_err());
}

#[test]
fn every_call_gets_its_answer_in_the_providers_words() {
    let calls = [
        ToolCall {
            id: "a1".into(),
            name: "read_open".into(),
            input: json!({}),
        },
        ToolCall {
            id: format!("{OWN_ID}1"),
            name: "sql_query".into(),
            input: json!({}),
        },
    ];
    let answers = [
        Answer {
            id: format!("{OWN_ID}1"),
            text: "denied".into(),
            failed: true,
        },
        Answer {
            id: "a1".into(),
            text: "SELECT 1".into(),
            failed: false,
        },
    ];
    let claude = results(Provider::Anthropic, &calls, &answers).unwrap();
    assert_eq!(
        claude,
        [json!({"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "a1", "content": "SELECT 1", "is_error": false},
            {"type": "tool_result", "tool_use_id": "nexo-call-1", "content": "denied", "is_error": true},
        ]})]
    );
    let openai = results(Provider::Compatible, &calls, &answers).unwrap();
    assert_eq!(
        openai[1],
        json!({"role": "tool", "tool_call_id": "nexo-call-1", "content": "denied"})
    );
    let gemini = results(Provider::Gemini, &calls, &answers).unwrap();
    assert_eq!(
        gemini[0]["parts"],
        json!([
            {"functionResponse": {"name": "read_open", "id": "a1", "response": {"result": "SELECT 1"}}},
            {"functionResponse": {"name": "sql_query", "response": {"error": "denied"}}},
        ])
    );
    assert!(results(Provider::Anthropic, &calls, &answers[..1]).is_err());
}
