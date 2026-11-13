use crate::{
    DriverError, ErrorCode,
    wire::{MAX_LINE, Message, read_line},
};
use serde_json::json;
use tokio::io::BufReader;

#[test]
fn messages_survive_their_line() {
    for message in [
        Message::Request {
            id: 7,
            method: "execute".into(),
            params: json!({"sql": "select 1"}),
        },
        Message::Response {
            id: 7,
            outcome: Ok(json!({"rows": [[1]]})),
        },
        Message::Response {
            id: 8,
            outcome: Ok(json!(null)),
        },
        Message::Response {
            id: 9,
            outcome: Err(DriverError::syntax("near FROM").with_detail(json!({"position": 12}))),
        },
        Message::Notification {
            method: "log".into(),
            params: json!({"level": "info", "message": "ready"}),
        },
    ] {
        let line = message.to_line();
        assert!(!line.contains('\n'), "{line}");
        assert_eq!(Message::parse(&line).unwrap(), message);
    }
}

#[test]
fn a_request_without_params_has_none() {
    let message = Message::parse(r#"{"id": 1, "method": "hello"}"#).unwrap();
    assert_eq!(
        message,
        Message::Request {
            id: 1,
            method: "hello".into(),
            params: json!(null)
        }
    );
}

#[test]
fn what_is_not_a_message_is_refused() {
    for line in [
        "",
        "[]",
        "not json",
        r#"{"id": "one", "method": "hello"}"#,
        r#"{"id": -1, "method": "hello"}"#,
        r#"{"method": 5}"#,
        r#"{"id": 1}"#,
        r#"{"params": {}}"#,
        r#"{"id": 1, "error": "plain text"}"#,
    ] {
        assert!(Message::parse(line).is_err(), "{line}");
    }
}

#[test]
fn error_codes_are_lower_case_words() {
    let line = Message::Response {
        id: 1,
        outcome: Err(DriverError::new(ErrorCode::Unsupported, "no")),
    }
    .to_line();
    assert!(line.contains(r#""code":"unsupported""#), "{line}");
}

#[tokio::test]
async fn lines_are_read_one_by_one() {
    let input: &[u8] = b"first\nsecond\r\n\nlast";
    let mut reader = BufReader::with_capacity(4, input);
    let mut line = Vec::new();
    let mut lines = Vec::new();
    while read_line(&mut reader, &mut line).await.unwrap() {
        lines.push(String::from_utf8(line.clone()).unwrap());
    }
    assert_eq!(lines, ["first", "second", "", "last"]);
}

#[tokio::test]
async fn a_line_longer_than_the_limit_ends_the_reading() {
    let input = vec![b'x'; MAX_LINE + 2];
    let mut reader = BufReader::new(input.as_slice());
    let mut line = Vec::new();
    let error = read_line(&mut reader, &mut line).await.unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
}
