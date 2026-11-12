use super::*;

#[test]
fn long_polling_payloads_carry_several_packets() {
    let frames = decode_payload("0{\"sid\":\"a\"}\u{1e}40\u{1e}bAQID\u{1e}");
    assert_eq!(
        frames,
        [
            Frame::Text("0{\"sid\":\"a\"}".into()),
            Frame::Text("40".into()),
            Frame::Binary(vec![1, 2, 3]),
        ]
    );
    assert_eq!(
        encode_payload(&[Frame::Text("3".into()), Frame::Binary(vec![255])]),
        "3\u{1e}b/w=="
    );
    assert_eq!(decode_payload(""), []);
}

#[test]
fn the_open_packet_gives_the_session_and_its_upgrades() {
    let open = handshake(
        r#"0{"sid":"s1","upgrades":["websocket"],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}"#,
    )
    .unwrap();
    assert_eq!(
        open,
        Handshake {
            sid: "s1".into(),
            upgrades: vec!["websocket".into()],
            ping_interval: 25_000,
            ping_timeout: 20_000,
        }
    );
    assert!(handshake("40").is_none());
    assert!(handshake("0{}").is_none());
}

#[test]
fn packets_with_namespaces_ids_and_data() {
    let mut decoder = Decoder::default();
    assert_eq!(
        decoder.text("2/chat,12[\"message\",{\"a\":1}]"),
        Some(Packet {
            kind: 2,
            namespace: "/chat".into(),
            id: Some(12),
            data: json!(["message", {"a": 1}]),
        })
    );
    assert_eq!(
        decoder.text("0{\"sid\":\"x\"}").unwrap().data,
        json!({"sid": "x"})
    );
    assert_eq!(decoder.text("1/chat,").unwrap().namespace, "/chat");
    assert!(decoder.text("9").is_none());
    assert!(decoder.text("2[broken").is_none());
}

#[test]
fn binary_events_wait_for_their_attachments() {
    let mut decoder = Decoder::default();
    let text = r#"52-/files,["upload",{"name":"a.png","file":{"_placeholder":true,"num":0}},{"_placeholder":true,"num":1}]"#;
    assert_eq!(decoder.text(text), None);
    assert_eq!(decoder.binary(vec![0x89, 0x50]), None);
    let packet = decoder.binary(vec![0xff]).unwrap();
    assert_eq!(packet.kind, 5);
    assert_eq!(packet.namespace, "/files");
    assert_eq!(
        packet.data,
        json!(["upload", {"name": "a.png", "file": {"$binary": "iVA="}}, {"$binary": "/w=="}])
    );
    // An attachment with nothing waiting for it is ignored.
    assert_eq!(decoder.binary(vec![1]), None);
    let ack = decoder.text(r#"61-7[{"_placeholder":true,"num":0}]"#);
    assert_eq!(ack, None);
    let ack = decoder.binary(vec![2]).unwrap();
    assert_eq!(
        (ack.kind, ack.id, ack.data),
        (6, Some(7), json!([{"$binary": "Ag=="}]))
    );
    assert!(decoder.text("5999-[]").is_none());
}

#[test]
fn events_with_binary_values_are_sent_as_attachments() {
    assert_eq!(
        event("/", "message", &json!({"a": 1})).unwrap(),
        [Frame::Text(r#"42["message",{"a":1}]"#.into())]
    );
    assert_eq!(
        event("/files", "upload", &json!({"file": {"$binary": "AQI="}, "more": [{"$binary": "Aw=="}]})).unwrap(),
        [
            Frame::Text(
                r#"452-/files,["upload",{"file":{"_placeholder":true,"num":0},"more":[{"_placeholder":true,"num":1}]}]"#.into()
            ),
            Frame::Binary(vec![1, 2]),
            Frame::Binary(vec![3]),
        ]
    );
    assert!(event("/", "x", &json!({"$binary": "%%"})).is_err());
    // Only an object with `$binary` alone is binary data.
    assert_eq!(
        event("/", "x", &json!({"$binary": "AQI=", "other": 1})).unwrap(),
        [Frame::Text(
            r#"42["x",{"$binary":"AQI=","other":1}]"#.into()
        )]
    );
}

#[test]
fn connect_and_disconnect_packets() {
    assert_eq!(connect("/", &Value::Null), "40");
    assert_eq!(
        connect("/admin", &json!({"token": "t"})),
        r#"40/admin,{"token":"t"}"#
    );
    assert_eq!(disconnect("/"), "41");
    assert_eq!(disconnect("/admin"), "41/admin,");
}
