//! Tasks with files (DB-40): a query written to a CSV or JSON file with `{date}` in its name,
//! a file written into a table by batches, and MongoDB's saved transfers to a collection or a
//! file and from a file; only with the files of the desktop app.
use super::*;
use crate::ports::TaskFiles;
use std::{collections::HashMap, sync::Mutex};

/// Files kept in memory, as the desktop app writes and reads them.
#[derive(Default)]
struct MemoryFiles(Mutex<HashMap<String, Vec<u8>>>);

#[async_trait::async_trait]
impl TaskFiles for MemoryFiles {
    async fn create(&self, path: &str, overwrite: bool) -> Result<String> {
        let mut files = self.0.lock().unwrap();
        if files.contains_key(path) && !overwrite {
            return Err(Error::Validation(format!("{path} exists")));
        }
        files.insert(path.into(), Vec::new());
        Ok(path.into())
    }
    async fn append(&self, path: &str, bytes: Vec<u8>) -> Result<()> {
        self.0.lock().unwrap().get_mut(path).unwrap().extend(bytes);
        Ok(())
    }
    async fn read(&self, path: &str, _: u64) -> Result<Vec<u8>> {
        self.0
            .lock()
            .unwrap()
            .get(path)
            .cloned()
            .ok_or_else(|| Error::Validation(format!("{path} is missing")))
    }
}
impl MemoryFiles {
    fn text(&self, path: &str) -> String {
        String::from_utf8(self.0.lock().unwrap()[path].clone()).unwrap()
    }
}

fn with_files(
    tasks: &[(&str, Value)],
) -> (
    Application,
    Arc<Fake>,
    Arc<crate::testing::datasources::FakeSources>,
    Arc<MemoryFiles>,
) {
    let (application, fake, sources) = setup(json!({}), "select 1", tasks);
    let files = Arc::new(MemoryFiles::default());
    (
        application.with_task_files(files.clone()),
        fake,
        sources,
        files,
    )
}

#[tokio::test]
async fn a_query_is_written_to_a_file_and_a_file_into_a_table() {
    let export = json!({"type": "export", "connection": "c1", "sql": "select n from t",
                        "format": "csv", "file": "/out/n-{date}.csv"});
    let json_export = json!({"type": "export", "connection": "c1", "sql": "select n from t",
                             "format": "json", "file": "/out/n.json", "overwrite": true});
    let import = json!({"type": "import", "connection": "c1", "format": "csv", "file": "/in/t.csv",
                        "table": "people", "schema": "public", "mode": "upsert", "key": ["id"]});
    let writing = json!({"type": "export", "connection": "c1", "sql": "delete from t where id = 1",
                         "format": "csv", "file": "/out/x.csv"});
    let (application, _, sources, files) = with_files(&[
        ("export", export),
        ("json", json_export),
        ("import", import),
        ("writing", writing),
    ]);
    let entry = run(&application, "export").await;
    assert_eq!(entry["state"], "passed", "{entry}");
    assert_eq!(entry["rows"], 2);
    let written: Vec<String> = files.0.lock().unwrap().keys().cloned().collect();
    assert!(
        written[0].starts_with("/out/n-2") && !written[0].contains("{date}"),
        "{written:?}"
    );
    assert_eq!(files.text(&written[0]), "n\r\n1\r\n2\r\n");
    assert_eq!(run(&application, "json").await["state"], "passed");
    let parsed: Value = serde_json::from_str(&files.text("/out/n.json")).unwrap();
    assert_eq!(parsed, json!([{"n": 1}, {"n": 2}]));
    // A statement that changes something is no export.
    let refused = run(&application, "writing").await;
    assert!(
        refused["error"]
            .as_str()
            .unwrap()
            .contains("changes something"),
        "{refused}"
    );

    files.create("/in/t.csv", false).await.unwrap();
    files
        .append("/in/t.csv", b"id,name\n1,Ana\n2,\n".to_vec())
        .await
        .unwrap();
    let imported = run(&application, "import").await;
    assert_eq!(imported["state"], "passed", "{imported}");
    assert_eq!(imported["rows"], 2);
    let (_, request) = sources.imported.lock().unwrap()[0].clone();
    assert_eq!(request["table"], "people");
    assert_eq!(request["schema"], "public");
    assert_eq!(request["columns"], json!(["id", "name"]));
    assert_eq!(request["rows"], json!([["1", "Ana"], ["2", null]]));
    assert_eq!(request["key"], json!(["id"]));
}

#[tokio::test]
async fn files_are_only_in_the_desktop_app() {
    let export = json!({"type": "export", "connection": "c1", "sql": "select 1",
                        "format": "csv", "file": "/out/a.csv"});
    let (application, _, _) = setup(json!({}), "select 1", &[("export", export)]);
    let entry = run(&application, "export").await;
    assert!(
        entry["error"].as_str().unwrap().contains("desktop app"),
        "{entry}"
    );
}

fn mongo(fake: &Fake, transfer: Value) {
    let mut documents = fake.documents.lock().unwrap();
    documents.push(document(
        "m1",
        DocumentKind::Connection,
        "Mongo",
        json!({"uri": "mongodb://db.test"}),
    ));
    documents.push(document(
        "m2",
        DocumentKind::Connection,
        "Copy",
        json!({"uri": "mongodb://copy.test"}),
    ));
    documents.push(document("tr", DocumentKind::Transfer, "Orders", transfer));
}

fn transfer(extra: Value) -> Value {
    let mut value = json!({"direction": "export", "connection": "m1", "database": "shop",
        "collection": "orders", "format": "jsonl", "flavour": "relaxed", "fields": ["_id", "total"],
        "destination": "collection", "to": {"connection": "m2", "database": "copy", "collection": "orders"},
        "mode": "insert", "key": [], "continueOnError": false, "mask": "",
        "built": {"pipeline": {"pipeline": [{"$match": {}}], "options": {}}}});
    if let (Value::Object(base), Value::Object(more)) = (&mut value, extra) {
        base.extend(more);
    }
    value
}

#[tokio::test]
async fn a_saved_mongodb_transfer_copies_exports_and_imports() {
    let tasks = [
        ("copy", json!({"type": "mongo-transfer", "transfer": "tr"})),
        (
            "file",
            json!({"type": "mongo-transfer", "transfer": "tr", "file": "/out/orders.jsonl"}),
        ),
        (
            "replace",
            json!({"type": "mongo-transfer", "transfer": "tr", "authorize": {"everyRow": true}}),
        ),
    ];
    let (application, fake, _, files) = with_files(&tasks);
    mongo(&fake, transfer(json!({})));
    let copied = run(&application, "copy").await;
    assert_eq!(copied["state"], "passed", "{copied}");
    assert_eq!(copied["rows"], 1);
    let (target, batch) = fake.imports.lock().unwrap()[0].clone();
    assert_eq!(
        (target.database.as_str(), target.collection.as_str()),
        ("copy", "orders")
    );
    assert_eq!(batch.documents.len(), 1);

    // To a file: the relaxed flavour writes plain numbers.
    fake.documents
        .lock()
        .unwrap()
        .retain(|d| d.id.as_str() != "tr");
    fake.documents.lock().unwrap().push(document(
        "tr",
        DocumentKind::Transfer,
        "Orders",
        transfer(json!({"destination": "file"})),
    ));
    assert_eq!(run(&application, "file").await["state"], "passed");
    assert_eq!(
        files.text("/out/orders.jsonl"),
        "{\"_id\":\"A\",\"total\":3}\n"
    );

    // Emptying the target needs the task's word; an old transfer without its query, saving again.
    fake.documents
        .lock()
        .unwrap()
        .retain(|d| d.id.as_str() != "tr");
    fake.documents.lock().unwrap().push(document(
        "tr",
        DocumentKind::Transfer,
        "Orders",
        transfer(json!({"mode": "replace"})),
    ));
    assert!(
        run(&application, "copy").await["error"]
            .as_str()
            .unwrap()
            .contains("emptying")
    );
    assert_eq!(run(&application, "replace").await["state"], "passed");
    fake.documents
        .lock()
        .unwrap()
        .retain(|d| d.id.as_str() != "tr");
    fake.documents.lock().unwrap().push(document(
        "tr",
        DocumentKind::Transfer,
        "Orders",
        transfer(json!({"built": null})),
    ));
    assert!(
        run(&application, "copy").await["error"]
            .as_str()
            .unwrap()
            .contains("save it again")
    );

    // From a JSON Lines file.
    fake.documents
        .lock()
        .unwrap()
        .retain(|d| d.id.as_str() != "tr");
    fake.documents.lock().unwrap().push(document(
        "tr",
        DocumentKind::Transfer,
        "Orders",
        transfer(json!({"direction": "import"})),
    ));
    files.create("/in/o.jsonl", false).await.unwrap();
    files
        .append(
            "/in/o.jsonl",
            b"{\"sku\":\"A\"}\n{\"sku\":\"B\"}\n".to_vec(),
        )
        .await
        .unwrap();
    let import = json!({"type": "mongo-transfer", "transfer": "tr", "file": "/in/o.jsonl"});
    fake.documents
        .lock()
        .unwrap()
        .push(document("in", DocumentKind::DbTask, "in", import));
    let entry = run(&application, "in").await;
    assert_eq!(entry["state"], "passed", "{entry}");
    assert_eq!(entry["rows"], 2);
}

#[tokio::test]
async fn a_saved_comparison_needs_its_filter_compiled_and_a_missing_one_is_said() {
    let task = json!({"type": "mongo-compare", "comparison": "cmp", "sync": true});
    let (application, fake, _, _) = with_files(&[("cmp-task", task)]);
    let missing = run(&application, "cmp-task").await;
    assert!(
        missing["error"]
            .as_str()
            .unwrap()
            .contains("no longer exists"),
        "{missing}"
    );
    mongo(&fake, transfer(json!({})));
    fake.documents.lock().unwrap().push(document(
        "cmp",
        DocumentKind::Comparison,
        "Cmp",
        json!({"connection": "m1", "database": "shop", "collection": "orders",
               "target": {"connection": "m2", "database": "copy", "collection": "orders"},
               "filter": "{status: 'A'}", "key": "_id", "ignore": [], "remove": false}),
    ));
    let entry = run(&application, "cmp-task").await;
    assert!(
        entry["error"].as_str().unwrap().contains("save it again"),
        "{entry}"
    );
}
