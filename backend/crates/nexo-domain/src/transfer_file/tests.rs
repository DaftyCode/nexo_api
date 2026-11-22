use super::*;
use serde_json::json;

#[test]
fn rows_are_written_as_csv_json_and_json_lines_page_after_page() {
    let columns = vec!["id".to_owned(), "name".to_owned(), "price".to_owned()];
    let page = [
        json!([1, "Ana; \"la\"", {"$t": "decimal", "v": "1.50"}]),
        json!([2, null, {"$t": "array", "v": [1, {"$t": "integer", "v": "9007199254740993"}]}]),
    ];
    let mut csv = FileWriter::new(FileFormat::Csv, ';', true, columns.clone());
    let text = csv.start() + &csv.rows(&page) + &csv.finish();
    assert_eq!(
        text,
        "id;name;price\r\n1;\"Ana; \"\"la\"\"\";1.50\r\n2;;\"[1,\"\"9007199254740993\"\"]\"\r\n"
    );
    let mut json = FileWriter::new(FileFormat::Json, ',', true, columns.clone());
    let text = json.start() + &json.rows(&page[..1]) + &json.rows(&page[1..]) + &json.finish();
    let parsed: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        parsed[0],
        json!({"id": 1, "name": "Ana; \"la\"", "price": "1.50"})
    );
    assert_eq!(parsed[1]["price"], json!([1, "9007199254740993"]));
    assert_eq!(json.written(), 2);
    let empty = FileWriter::new(FileFormat::Json, ',', true, columns.clone());
    assert_eq!(empty.start() + &empty.finish(), "[]\n");
    let mut lines = FileWriter::new(FileFormat::JsonLines, ',', true, columns);
    assert_eq!(lines.start(), "");
    assert_eq!(lines.rows(&page[..1]).lines().count(), 1);
    assert_eq!(lines.finish(), "");
    let headless = FileWriter::new(FileFormat::Csv, ',', false, vec!["a".into()]);
    assert_eq!(headless.start(), "");
}

#[test]
fn files_are_read_back_as_columns_and_rows() {
    let text = "\u{feff}id,name,note\r\n1,\"Ana, \"\"la\"\"\",\"two\nlines\"\n2,,\n";
    let (columns, rows) = read_rows(text, FileFormat::Csv, ',', true).unwrap();
    assert_eq!(columns, ["id", "name", "note"]);
    assert_eq!(rows[0], json!(["1", "Ana, \"la\"", "two\nlines"]));
    assert_eq!(rows[1], json!(["2", null, null]));
    let (_, kept) = read_rows("a,b\n,x", FileFormat::Csv, ',', false).unwrap();
    assert_eq!(kept[0], json!(["", "x"]));
    assert!(read_rows("", FileFormat::Csv, ',', true).is_err());
    assert!(read_csv("a,\"b", ',').is_err());

    let json = r#"[{"id": 1, "tags": ["a"]}, {"id": 2, "name": "Bo"}]"#;
    let (columns, rows) = read_rows(json, FileFormat::Json, ',', true).unwrap();
    assert_eq!(columns, ["id", "tags", "name"]);
    assert_eq!(rows[1], json!([2, null, "Bo"]));
    let lines = "{\"a\": 1}\n\n{\"a\": 2}\n";
    assert_eq!(read_objects(lines, FileFormat::JsonLines).unwrap().len(), 2);
    for bad in ["{\"a\": 1}", "[1]", "[{"] {
        assert!(read_objects(bad, FileFormat::Json).is_err(), "{bad}");
    }
    assert!(read_objects("{\"a\":1}\nnope", FileFormat::JsonLines).is_err());
    assert!(read_objects("a", FileFormat::Csv).is_err());
}

#[test]
fn documents_and_file_names() {
    let documents = [
        json!({"_id": {"$oid": "65a1b2c3d4e5f6a7b8c9d0e1"}}),
        json!({"n": 1}),
    ];
    let json = document_lines(&documents, FileFormat::Json, true);
    let parsed: Value = serde_json::from_str(&format!("[{json}\n]")).unwrap();
    assert_eq!(parsed[1], json!({"n": 1}));
    assert_eq!(
        document_lines(&documents[1..], FileFormat::Json, false),
        ",\n  {\"n\":1}"
    );
    assert_eq!(
        document_lines(&documents[1..], FileFormat::JsonLines, true),
        "{\"n\":1}\n"
    );
    assert_eq!(
        dated("C:/exports/orders-{date}.csv", 1_795_343_400_000),
        "C:/exports/orders-2026-11-22_103000.csv"
    );
    assert_eq!(dated("/tmp/a.csv", 0), "/tmp/a.csv");
    assert_eq!(dated("{date}", 951_782_400_000), "2000-02-29_000000");
    assert_eq!(FileFormat::parse("jsonl").unwrap(), FileFormat::JsonLines);
    assert!(FileFormat::parse("xml").is_err());
    assert_eq!(cell_text(&json!(true)), Some("true".into()));
    assert_eq!(cell_text(&json!({"a": 1})), Some("{\"a\":1}".into()));
}
