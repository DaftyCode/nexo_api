use super::*;

fn files(entries: Value) -> Files {
    Files::from_payload(&json!({ "files": entries })).unwrap()
}

#[test]
fn each_reference_gets_the_file_chosen_for_its_name_once() {
    let chosen = files(json!([
        {"src": "a.png", "content": STANDARD.encode([1, 2]), "contentType": "image/png"},
        {"src": "a.png", "content": STANDARD.encode([3])},
        {"src": "doc.pdf", "content": STANDARD.encode(b"%PDF")},
    ]));
    let mut request = json!({"body": {"mode": "formdata", "formdata": [
        {"key": "first", "type": "file", "src": "a.png"},
        {"key": "second", "type": "file", "src": ["a.png", "missing.txt"], "contentType": "x/y"},
        {"key": "text", "value": "v"},
        {"key": "unset", "type": "file", "src": null},
        {"key": "doc", "type": "file", "src": "C:\\files\\doc.pdf"},
    ]}});
    chosen.attach(&mut request);
    let rows = request["body"]["formdata"].as_array().unwrap();
    let first = attached(&rows[0]).unwrap();
    assert_eq!(
        (first[0].name.as_str(), first[0].bytes.as_slice()),
        ("a.png", &[1u8, 2][..])
    );
    assert_eq!(first[0].content_type, "image/png");
    let second = attached(&rows[1]).unwrap();
    assert_eq!(second.len(), 1, "missing.txt was not chosen");
    assert_eq!(
        (second[0].bytes.as_slice(), second[0].content_type.as_str()),
        (&[3u8][..], "x/y")
    );
    assert!(rows[2].get(ATTACHED).is_none());
    assert!(rows[3].get(ATTACHED).is_none());
    assert!(
        attached(&rows[4]).unwrap().is_empty(),
        "a path is not the chosen name"
    );

    let stripped = without_contents(request);
    assert!(!stripped.to_string().contains(ATTACHED));
}

#[test]
fn a_binary_body_gets_its_file() {
    let chosen = files(json!([{"src": "dir/photo.JPG", "content": STANDARD.encode([9])}]));
    let mut request = json!({"body": {"mode": "file", "file": {"src": "dir/photo.JPG"}}});
    chosen.attach(&mut request);
    let parts = attached(&request["body"]["file"]).unwrap();
    assert_eq!(parts[0].name, "photo.JPG");
    assert_eq!(parts[0].content_type, "image/jpeg");
    assert_eq!(parts[0].bytes, vec![9]);
    assert!(
        without_contents(request)["body"]["file"]
            .get(ATTACHED)
            .is_none()
    );
}

#[test]
fn invalid_or_too_large_files_are_refused() {
    let invalid = Files::from_payload(&json!({"files": [{"src": "a", "content": "%%"}]}));
    assert!(
        invalid
            .unwrap_err()
            .to_string()
            .contains("File a is not valid base64")
    );
    let big = STANDARD.encode(vec![0u8; MAX_TOTAL / 2 + 1]);
    let too_large = Files::from_payload(&json!({"files": [
        {"src": "a", "content": big}, {"src": "b", "content": big}
    ]}));
    assert!(too_large.unwrap_err().to_string().contains("32 MB"));
    assert!(Files::from_payload(&json!({})).unwrap().0.is_empty());
}

#[test]
fn media_types_follow_the_extension() {
    assert_eq!(content_type_of("a/b/report.CSV"), "text/csv");
    assert_eq!(content_type_of("archive"), "application/octet-stream");
    assert_eq!(file_name("C:\\x\\y.txt"), "y.txt");
    assert_eq!(sources(&json!(["", "a"])), vec!["a".to_string()]);
}
