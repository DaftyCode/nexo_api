use super::*;
#[test]
fn junit_escapes_and_counts() {
    let report = junit(
        &json!({"assertions":[
            {"name":"ok <1>","passed":true,"iteration":0},
            {"name":"bad\u{0001}","passed":false,"error":"x & y","iteration":1},
            {"name":"later","passed":true,"skipped":true}
        ]}),
        1.5,
    );
    assert!(report.contains("tests=\"3\" failures=\"1\""));
    assert!(report.contains("ok &lt;1&gt;"));
    assert!(report.contains("x &amp; y"));
    assert!(report.contains("<skipped/>"));
    assert!(!report.contains('\u{0001}'));
}
#[test]
fn files_are_read_next_to_the_collection_once_per_use() {
    let folder = std::env::temp_dir().join(format!("nexo-cli-files-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(folder.join("img")).unwrap();
    std::fs::write(folder.join("img/a.png"), [1u8, 2]).unwrap();
    std::fs::write(folder.join("body.bin"), [3u8]).unwrap();
    let collection = json!({"item": [
        {"name": "Form", "request": {"body": {"mode": "formdata", "formdata": [
            {"key": "x", "type": "file", "src": "img/a.png"},
            {"key": "y", "type": "file", "src": ["img/a.png", "missing.txt"]},
            {"key": "z", "type": "file", "src": "img/a.png", "disabled": true},
            {"key": "t", "value": "text"}
        ]}}},
        {"name": "Folder", "item": [
            {"name": "Binary", "request": {"body": {"mode": "file", "file": {"src": "body.bin"}}}},
            {"name": "Again", "request": {"body": {"mode": "file", "file": {"src": "img/a.png"}}}}
        ]}
    ]});
    let entries = files(&collection, &folder);
    let names: Vec<&str> = entries
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["src"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["img/a.png", "img/a.png", "body.bin"]);
    assert_eq!(entries[0]["content"], STANDARD.encode([1u8, 2]));
    let request = json!({"body": {"mode": "file", "file": {"src": "body.bin"}}});
    assert_eq!(
        files(&request, &folder)[0]["content"],
        STANDARD.encode([3u8])
    );
    std::fs::remove_dir_all(folder).unwrap();
}
