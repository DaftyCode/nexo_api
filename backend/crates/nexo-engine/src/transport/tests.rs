use super::*;
#[test]
fn decodes_binary_and_charsets() {
    let (body, encoding) = decode_body(&[0x89, 0x50, 0, 1], "image/png");
    assert_eq!(encoding, Some("base64"));
    assert_eq!(STANDARD.decode(body).unwrap(), [0x89, 0x50, 0, 1]);
    let (text, _) = decode_body(
        &[0x45, 0x73, 0x70, 0x61, 0xf1, 0x61],
        "text/plain; charset=iso-8859-1",
    );
    assert_eq!(text, "España");
    assert_eq!(decode_body(b"{\"a\":1}", "application/json").0, "{\"a\":1}");
}
#[test]
fn multipart_sends_file_bytes_as_chosen() {
    let bytes = [0x89u8, 0x50, 0x00, 0xff, 0xfe, b'\r', b'\n'];
    let mut request = json!({"body": {"mode": "formdata", "formdata": [
        {"key": "note", "value": "hi", "contentType": "text/plain"},
        {"key": "avatar\"", "type": "file", "src": "my \"photo\".png"},
        {"key": "off", "type": "file", "src": "x.bin", "disabled": true},
        {"key": "empty", "type": "file"},
    ]}});
    crate::files::Files::from_payload(&json!({"files": [
        {"src": "my \"photo\".png", "content": STANDARD.encode(bytes), "contentType": "image/png"}
    ]}))
    .unwrap()
    .attach(&mut request);
    let (content_type, body) = multipart(request["body"]["formdata"].as_array().unwrap()).unwrap();
    let boundary = content_type.split("boundary=").nth(1).unwrap();
    let mut expected = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"note\"\r\nContent-Type: text/plain\r\n\r\nhi\r\n\
             --{boundary}\r\nContent-Disposition: form-data; name=\"avatar%22\"; filename=\"my %22photo%22.png\"\r\nContent-Type: image/png\r\n\r\n"
    )
    .into_bytes();
    expected.extend_from_slice(&bytes);
    expected.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    assert_eq!(body, expected);

    let missing = json!([{"key": "avatar", "type": "file", "src": "photo.png"}]);
    let error = multipart(missing.as_array().unwrap()).unwrap_err();
    assert_eq!(
        error.to_string(),
        "Choose the file photo.png for the form-data field avatar"
    );
}
