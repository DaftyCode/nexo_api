//! The shell on a fake database: mongosh's syntax, its results and the confirmation that
//! destructive commands need.
use super::*;
use async_trait::async_trait;
use nexo_application::ports::{ScriptCall, ScriptDatabase};
use std::sync::Mutex;

#[derive(Default)]
struct Fake {
    calls: Mutex<Vec<ScriptCall>>,
}

#[async_trait]
impl ScriptDatabase for Fake {
    async fn script_call(&self, call: ScriptCall) -> Result<Value> {
        self.calls.lock().unwrap().push(call.clone());
        match call.method.as_str() {
            "listDatabases" => Ok(json!([{"name": "admin"}, {"name": "shop"}])),
            "listCollections" => Ok(json!([{"name": "orders"}, {"name": "customers"}])),
            "find" => {
                Ok(json!([{"_id": {"$oid": "65a1b2c3d4e5f6a7b8c9d0e1"}, "n": {"$numberInt": "1"}}]))
            }
            "countDocuments" => Ok(json!(3)),
            "drop" | "dropDatabase" if call.confirm.as_deref() != Some("orders") => Err(
                Error::Validation("Type the name of the collection to confirm: orders".into()),
            ),
            "drop" => Ok(json!(true)),
            other => Ok(json!({ "method": other })),
        }
    }
}

async fn shell(fake: &Arc<Fake>, command: &str, confirm: Option<&str>) -> Result<Value> {
    let databases = ScriptDatabases::default();
    let connected: Arc<dyn ScriptDatabase> = fake.clone();
    databases.connect(Arc::downgrade(&connected));
    let mut payload = json!({"workspace": "local", "connection": "c1", "database": "shop",
                             "command": command, "variables": {"host": "db.test"}});
    if let Some(confirm) = confirm {
        payload["confirm"] = json!(confirm);
    }
    run(databases, payload).await
}

#[test]
fn use_and_show_become_calls() {
    assert_eq!(
        translate("use shop\nshow collections;\ndb.orders.find()"),
        "use(\"shop\");\nshow(\"collections\");\ndb.orders.find()"
    );
    assert_eq!(translate("  show dbs  "), "show(\"dbs\");");
    assert_eq!(translate("const use = 1"), "const use = 1");
}

#[tokio::test(flavor = "multi_thread")]
async fn runs_the_usual_commands_of_mongosh() {
    let fake = Arc::new(Fake::default());
    let found = shell(&fake, "db.orders.find({ n: { $gt: 0 } })", None)
        .await
        .unwrap();
    assert_eq!(found["kind"], "documents");
    assert_eq!(
        found["value"][0]["_id"],
        json!({"$oid": "65a1b2c3d4e5f6a7b8c9d0e1"})
    );
    assert_eq!(found["database"], "shop");
    {
        let calls = fake.calls.lock().unwrap();
        let call = &calls[0];
        assert_eq!(
            (
                call.connection.as_str(),
                call.database.as_str(),
                call.collection.as_str()
            ),
            ("c1", "shop", "orders")
        );
        assert_eq!(
            call.arguments[1],
            json!({"limit": 50}),
            "a cursor shows its first documents"
        );
        assert_eq!(call.variables["host"], "db.test");
    }
    let limited = shell(&fake, "db.orders.find().limit(5).sort({ n: -1 })", None)
        .await
        .unwrap();
    assert_eq!(limited["kind"], "documents");
    assert_eq!(
        fake.calls.lock().unwrap()[1].arguments[1],
        json!({"limit": 5, "sort": {"n": -1}})
    );

    let shown = shell(&fake, "show collections", None).await.unwrap();
    assert_eq!(shown["value"], json!(["customers", "orders"]));
    let databases = shell(&fake, "show dbs", None).await.unwrap();
    assert_eq!(databases["value"], json!(["admin", "shop"]));
    let switched = shell(&fake, "use other\ndb.items.countDocuments()", None)
        .await
        .unwrap();
    assert_eq!(
        (switched["database"].as_str(), switched["value"].as_i64()),
        (Some("other"), Some(3))
    );
    assert_eq!(fake.calls.lock().unwrap().last().unwrap().database, "other");
    let sibling = shell(
        &fake,
        "db.getSiblingDB('logs').events.estimatedDocumentCount()",
        None,
    )
    .await
    .unwrap();
    assert_eq!(sibling["value"]["method"], "estimatedDocumentCount");
    let printed = shell(
        &fake,
        "print('a', 1); printjson({ id: ObjectId('65a1b2c3d4e5f6a7b8c9d0e1') }); const x = 2",
        None,
    )
    .await
    .unwrap();
    assert_eq!(printed["kind"], "none");
    assert_eq!(printed["logs"][0], json!(["a", "1"]));
    assert!(printed["logs"][1][0].as_str().unwrap().contains("\"$oid\""));
}

#[tokio::test(flavor = "multi_thread")]
async fn destructive_commands_need_the_name_and_errors_are_explained() {
    let fake = Arc::new(Fake::default());
    let refused = shell(&fake, "db.orders.drop()", None).await.unwrap_err();
    assert_eq!(
        refused.to_string(),
        "Type the name of the collection to confirm: orders"
    );
    let dropped = shell(&fake, "db.orders.drop()", Some("orders"))
        .await
        .unwrap();
    assert_eq!(dropped["value"], true);
    assert_eq!(
        fake.calls
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .confirm
            .as_deref(),
        Some("orders")
    );
    let syntax = shell(&fake, "db.orders.find(", None).await.unwrap_err();
    assert!(syntax.to_string().contains("SyntaxError"), "{syntax}");
    let unknown = shell(&fake, "show users", None).await.unwrap_err();
    assert!(
        unknown.to_string().contains("show users is not known"),
        "{unknown}"
    );
    assert_eq!(
        shell(&fake, "  ", None).await.unwrap_err().to_string(),
        "Write a command"
    );
    // Without the application (nexo-cli), the shell says so.
    let alone = run(
        ScriptDatabases::default(),
        json!({"connection": "c1", "database": "shop", "command": "db.orders.findOne()"}),
    )
    .await
    .unwrap_err();
    assert!(alone.to_string().contains("not available here"), "{alone}");
}
