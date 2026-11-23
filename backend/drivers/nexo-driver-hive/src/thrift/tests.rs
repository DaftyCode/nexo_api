use super::*;

#[test]
fn a_call_and_its_reply_travel_in_the_binary_protocol() {
    let request = Builder::new()
        .set(1, Thrift::I32(9))
        .set(2, Thrift::text("ana"))
        .set(
            4,
            Thrift::Map(
                kind::STRING,
                kind::STRING,
                vec![(Thrift::text("use:database"), Thrift::text("shop"))],
            ),
        )
        .build();
    let bytes = call("OpenSession", 1, request.clone());
    assert_eq!(&bytes[..4], &[0x80, 0x01, 0x00, 0x01]);
    // A reply carries the result in field 0 of its struct.
    let mut answer = Vec::new();
    answer.extend_from_slice(&(0x8001_0002u32 as i32).to_be_bytes());
    write_bytes(&mut answer, b"OpenSession");
    answer.extend_from_slice(&1i32.to_be_bytes());
    write_value(&mut answer, &Builder::new().set(0, request.clone()).build());
    let result = reply(&answer, "OpenSession").unwrap();
    assert_eq!(result, request);
    assert_eq!(
        result.field(2).and_then(Thrift::string).as_deref(),
        Some("ana")
    );
    assert_eq!(result.field(1).and_then(Thrift::i32), Some(9));
}

#[test]
fn exceptions_and_broken_answers_are_errors() {
    let mut exception = Vec::new();
    exception.extend_from_slice(&(0x8001_0003u32 as i32).to_be_bytes());
    write_bytes(&mut exception, b"FetchResults");
    exception.extend_from_slice(&1i32.to_be_bytes());
    write_value(
        &mut exception,
        &Builder::new()
            .set(1, Thrift::text("Invalid method"))
            .build(),
    );
    let error = reply(&exception, "FetchResults").unwrap_err();
    assert!(error.message.contains("Invalid method"), "{error}");
    assert!(
        reply(b"<html>", "X")
            .unwrap_err()
            .message
            .contains("Thrift")
    );
    let mut cut = call("X", 1, Builder::new().build());
    cut.truncate(cut.len() - 1);
    cut[3] = 2;
    assert!(reply(&cut, "X").is_err());
    // A container that claims more items than any answer has.
    let mut huge = Vec::new();
    huge.extend_from_slice(&(0x8001_0002u32 as i32).to_be_bytes());
    write_bytes(&mut huge, b"X");
    huge.extend_from_slice(&1i32.to_be_bytes());
    huge.extend_from_slice(&[kind::LIST, 0, 0, kind::I32]);
    huge.extend_from_slice(&i32::MAX.to_be_bytes());
    assert!(reply(&huge, "X").is_err());
}
