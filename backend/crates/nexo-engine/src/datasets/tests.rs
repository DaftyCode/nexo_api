use super::*;
#[test]
fn csv_keeps_text_that_looks_numeric() {
    let rows =
        parse_csv("\u{feff}id,code,price,name\r\n1,01234,2.50,\"a, \"\"b\"\"\"\n2,-0,3.5,c\n\n")
            .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["id"], 1);
    assert_eq!(rows[0]["code"], "01234");
    assert_eq!(rows[0]["price"], "2.50");
    assert_eq!(rows[0]["name"], "a, \"b\"");
    assert_eq!(rows[1]["code"], "-0");
    assert_eq!(rows[1]["price"], 3.5);
    assert!(parse_csv("a\n\"open").is_err());
}
#[test]
fn queries_are_read_only_and_scoped() {
    let directory = std::env::temp_dir().join(format!("nexo-datasets-{}", uuid::Uuid::new_v4()));
    let datasets = Datasets::new(directory.clone());
    let imported = datasets
        .import(&json!({"id": "d", "scope": "workspace:a", "content": "[{\"n\":1,\"ok\":true},{\"n\":2,\"tags\":[1]}]"}))
        .unwrap();
    assert_eq!(imported["columns"], json!(["n", "ok", "tags"]));
    let result = datasets
        .query(&json!({"id": "d", "scope": "workspace:a", "sql": "SELECT n, ok, tags FROM data ORDER BY n DESC;"}))
        .unwrap();
    assert_eq!(
        result["rows"],
        json!([{"n": 2, "ok": null, "tags": "[1]"}, {"n": 1, "ok": 1, "tags": null}])
    );
    assert!(
        datasets
            .query(&json!({"id": "d", "scope": "workspace:b"}))
            .is_err()
    );
    for sql in [
        "DELETE FROM data",
        "SELECT 1; DROP TABLE data",
        "ATTACH DATABASE 'x.db' AS x",
        "PRAGMA table_info(data)",
        "CREATE TABLE t(a)",
    ] {
        assert!(
            datasets
                .query(&json!({"id": "d", "scope": "workspace:a", "sql": sql}))
                .is_err(),
            "{sql}"
        );
    }
    let slow = datasets
        .query(&json!({"id": "d", "scope": "workspace:a",
            "sql": "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c"}))
        .unwrap_err();
    assert!(slow.to_string().contains("5 second"), "{slow}");
    datasets
        .remove(&json!({"id": "d", "scope": "workspace:a"}))
        .unwrap();
    assert!(
        datasets
            .query(&json!({"id": "d", "scope": "workspace:a"}))
            .is_err()
    );
    let _ = std::fs::remove_dir_all(directory);
}
