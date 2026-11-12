use super::*;
const PROTO: &str = r#"
syntax = "proto3";
package demo;
import "google/protobuf/timestamp.proto";
message Hello { string name = 1; int64 count = 2; google.protobuf.Timestamp at = 3; Kind kind = 4; }
enum Kind { A = 0; B = 1; }
service Greeter { rpc Say (Hello) returns (Hello); rpc Watch (Hello) returns (stream Hello); }
"#;
#[tokio::test]
async fn lists_services_and_validates_input() {
    let result = request(&json!({"proto": PROTO}), &Policy::AllowAll, &[])
        .await
        .unwrap();
    assert_eq!(result["services"], json!(["demo.Greeter"]));
    assert_eq!(
        result["methods"]["demo.Greeter"],
        json!([
            {"name": "Say", "input": "demo.Hello", "output": "demo.Hello",
             "clientStreaming": false, "serverStreaming": false},
            {"name": "Watch", "input": "demo.Hello", "output": "demo.Hello",
             "clientStreaming": false, "serverStreaming": true},
        ])
    );
    let missing = request(
        &json!({"proto": "syntax = \"proto3\"; import \"other.proto\";"}),
        &Policy::AllowAll,
        &[],
    )
    .await
    .unwrap_err();
    assert!(missing.to_string().contains("inline it"), "{missing}");
    let method = request(
        &json!({"proto": PROTO, "service": "demo.Greeter", "method": "Nope", "url": "127.0.0.1:1"}),
        &Policy::AllowAll,
        &[],
    )
    .await
    .unwrap_err();
    assert!(method.to_string().contains("Say, Watch"), "{method}");
}
#[test]
fn messages_round_trip_through_json() {
    let pool = compile(PROTO).unwrap();
    let descriptor = pool.get_message_by_name("demo.Hello").unwrap();
    let message = from_json(
        &descriptor,
        &json!({"name": "Nexo", "count": "9007199254740993", "kind": "B", "extra": 1}),
    )
    .unwrap();
    let value = to_json(&message);
    assert_eq!(value["name"], "Nexo");
    assert_eq!(value["count"], "9007199254740993");
    assert_eq!(value["kind"], "B");
    assert!(from_json(&descriptor, &json!({"name": 5})).is_err());
}
