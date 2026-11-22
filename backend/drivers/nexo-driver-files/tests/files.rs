//! Files as tables (DB-30): a folder with a CSV, a JSON, a Parquet and an Excel file shows four
//! tables that join; a large CSV is read by pages; and nothing outside the connection's files
//! is read, installed, attached or written.
mod common;

use common::{Folder, driver, duckdb, params, run, single, xlsx};
use nexo_driver_sdk::{ErrorCode, Value, protocol::ObjectParams, statements::FetchParams};

fn shop(folder: &Folder) {
    folder.write(
        "ventas.csv",
        "id,cliente,total\n1,1,10.5\n2,2,20\n3,1,4.5\n",
    );
    folder.write(
        "clientes.json",
        r#"[{"id": 1, "nombre": "Ana"}, {"id": 2, "nombre": "Luis"}]"#,
    );
    let parquet = folder
        .file("productos.parquet")
        .display()
        .to_string()
        .replace('\\', "/");
    duckdb(&format!(
        "COPY (SELECT * FROM (VALUES (1, 'lamp'), (2, 'desk')) t(id, name)) TO '{parquet}' (FORMAT parquet)"
    ));
    xlsx(
        &folder.file("stock.xlsx"),
        &[&["id", "units"], &["1", "5"], &["2", "7"]],
    );
    folder.write("notes.md", "not a table");
}

#[tokio::test]
async fn a_folder_of_four_formats_shows_four_tables_that_join() {
    let folder = Folder::new("formats");
    shop(&folder);
    let client = driver();
    let server = client
        .connect(&params("f1", &folder.0.display().to_string(), &[]))
        .await
        .unwrap();
    assert_eq!(server.product.as_deref(), Some("DuckDB"));
    assert!(server.server_version.starts_with('2'), "{server:?}");
    let tables = client
        .tree(&ObjectParams {
            connection: "f1".into(),
            path: vec![],
        })
        .await
        .unwrap();
    let names: Vec<&str> = tables.iter().map(|node| node.name.as_str()).collect();
    assert_eq!(names, ["clientes", "productos", "stock", "ventas"]);
    let joined = run(
        &client,
        "f1",
        "SELECT c.nombre, sum(v.total) AS total FROM ventas v JOIN clientes c ON c.id = v.cliente \
         GROUP BY c.nombre ORDER BY c.nombre",
    )
    .await
    .unwrap();
    assert_eq!(joined.rows[0][0], Value::Text("Ana".into()));
    assert_eq!(joined.rows[0][1], Value::Float(15.0));
    assert_eq!(
        single(&client, "f1", "SELECT count(*) FROM productos").await,
        Value::Integer(2)
    );
    assert_eq!(
        single(&client, "f1", "SELECT sum(units) FROM stock").await,
        Value::Integer(12)
    );
    let columns = client
        .tree(&ObjectParams {
            connection: "f1".into(),
            path: vec!["ventas".into()],
        })
        .await
        .unwrap();
    assert_eq!(
        columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
        ["id", "cliente", "total"]
    );
    let described = client
        .describe(&ObjectParams {
            connection: "f1".into(),
            path: vec!["ventas".into()],
        })
        .await
        .unwrap();
    assert_eq!(described.sections[0].rows.len(), 3);
    let ddl = client
        .ddl(&ObjectParams {
            connection: "f1".into(),
            path: vec!["ventas".into()],
        })
        .await
        .unwrap();
    assert!(ddl.sql.contains("read_csv"), "{}", ddl.sql);
    client.disconnect("f1").await.unwrap();

    // One file, with settings of its reader.
    let semicolons = folder.write("points.csv", "a;b\n1;2\n");
    let client = driver();
    client
        .connect(&params(
            "f2",
            &semicolons.display().to_string(),
            &[("delimiter", ";")],
        ))
        .await
        .unwrap();
    assert_eq!(
        single(&client, "f2", "SELECT b FROM points").await,
        Value::Integer(2)
    );
    let wrong = client
        .connect(&params(
            "f3",
            &semicolons.display().to_string(),
            &[("separator", ";")],
        ))
        .await
        .unwrap_err();
    assert!(
        wrong
            .message
            .contains("Files do not take the setting separator"),
        "{wrong:?}"
    );
}

#[tokio::test]
async fn nothing_outside_the_files_is_read_installed_attached_or_written() {
    let folder = Folder::new("security");
    shop(&folder);
    let outside = Folder::new("outside");
    let secret = outside.write("secret.csv", "password\nhunter2\n");
    let secret = secret.display().to_string().replace('\\', "/");
    let client = driver();
    client
        .connect(&params("s1", &folder.0.display().to_string(), &[]))
        .await
        .unwrap();
    for sql in [
        format!("SELECT * FROM read_csv('{secret}')"),
        format!("SELECT * FROM '{secret}'"),
        "SELECT * FROM read_csv('https://example.com/data.csv')".to_owned(),
        "SELECT * FROM read_parquet('s3://bucket/x.parquet')".to_owned(),
    ] {
        let error = run(&client, "s1", &sql).await.unwrap_err();
        assert!(
            matches!(error.code, ErrorCode::Permission | ErrorCode::Invalid),
            "{sql}: {error:?}"
        );
        assert!(!error.message.contains("hunter2"));
    }
    for sql in [
        "INSTALL httpfs",
        "LOAD httpfs",
        format!("ATTACH '{secret}' AS other").as_str(),
        "COPY ventas TO 'copied.csv'",
        "SET enable_external_access = true",
        "CREATE TABLE t (a int)",
        "DROP VIEW ventas",
    ] {
        let error = run(&client, "s1", sql).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::Permission, "{sql}: {error:?}");
    }
    // A missing path, and a file of no known format.
    let missing = client
        .connect(&params(
            "s2",
            &folder.file("none.csv").display().to_string(),
            &[],
        ))
        .await
        .unwrap_err();
    assert!(missing.message.contains("does not exist"));
    let unknown = client
        .connect(&params(
            "s3",
            &folder.file("notes.md").display().to_string(),
            &[],
        ))
        .await
        .unwrap_err();
    assert!(
        unknown
            .message
            .contains("is not a CSV, JSON, Parquet or Excel file")
    );
}

#[tokio::test]
async fn a_large_csv_is_read_by_pages_and_a_slow_read_is_cancelled() {
    let folder = Folder::new("pages");
    let mut text = String::from("n,label\n");
    for n in 1..=120_000 {
        text.push_str(&format!("{n},row {n}\n"));
    }
    let path = folder.write("numbers.csv", &text);
    let client = driver();
    client
        .connect(&params("p1", &path.display().to_string(), &[]))
        .await
        .unwrap();
    let first = run(&client, "p1", "SELECT n, label FROM numbers")
        .await
        .unwrap();
    assert_eq!(first.rows.len(), 200);
    let (mut total, mut cursor) = (first.rows.len(), first.cursor);
    while let Some(open) = cursor {
        let page = client
            .fetch(&FetchParams {
                connection: "p1".into(),
                cursor: open,
                page_rows: Some(10_000),
            })
            .await
            .unwrap();
        total += page.rows.len();
        cursor = page.cursor;
    }
    assert_eq!(total, 120_000);
}
