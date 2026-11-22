use super::*;
use serde_json::{Value, json};

fn round_trip<T>(value: T) -> Value
where
    T: Serialize + serde::de::DeserializeOwned + PartialEq + std::fmt::Debug,
{
    let written = serde_json::to_value(&value).unwrap();
    let read: T = serde_json::from_value(written.clone()).unwrap();
    assert_eq!(read, value);
    written
}

#[test]
fn requests_travel_with_their_connection_and_lose_nothing() {
    let find = On {
        connection: "c".into(),
        request: FindRequest {
            id: "q1".into(),
            database: "shop".into(),
            collection: "orders".into(),
            filter: Some(json!({"n": {"$numberLong": "5"}})),
            page_size: 50,
            ..FindRequest::default()
        },
    };
    let written = round_trip(find);
    assert_eq!(written["request"]["pageSize"], 50);
    assert_eq!(written["request"]["filter"]["n"]["$numberLong"], "5");
    let explain = ExplainRequest {
        id: "e".into(),
        database: "shop".into(),
        collection: "orders".into(),
        explained: Explained::Aggregate {
            pipeline: vec![json!({"$match": {}})],
            collation: None,
            hint: Some(json!("_id_")),
        },
        execution_stats: true,
    };
    assert_eq!(round_trip(explain)["explained"]["kind"], "aggregate");
    let find = Explained::Find(Box::default());
    assert_eq!(round_trip(find)["kind"], "find");
    let profile = ProfileRequest {
        database: "shop".into(),
        set: Some((1, Some(100))),
    };
    assert_eq!(round_trip(profile)["set"], json!([1, 100]));
}

#[test]
fn writes_name_their_kind_and_keep_their_changes() {
    let write = WriteRequest {
        target: WriteTarget {
            database: "shop".into(),
            collection: "orders".into(),
            write_concern: Some(json!({"w": "majority"})),
        },
        write: DocumentWrite::Update {
            filter: json!({}),
            update: json!({"$set": {"a": 1}}),
            many: true,
            expected: Some(3),
        },
    };
    let written = round_trip(write);
    assert_eq!(written["write"]["kind"], "update");
    assert_eq!(written["target"]["writeConcern"]["w"], "majority");
    let result = WriteResult {
        matched: 1,
        modified: 1,
        changes: vec![DocumentChange {
            before: Some(json!({"a": 0})),
            after: Some(json!({"a": 1})),
        }],
        ..WriteResult::default()
    };
    assert_eq!(round_trip(result)["changes"][0]["after"]["a"], 1);
    let change = CollectionChange::Validator {
        database: "shop".into(),
        collection: "orders".into(),
        validator: json!({}),
        level: "strict".into(),
        action: "warn".into(),
    };
    assert_eq!(round_trip(change)["kind"], "validator");
    assert_eq!(
        round_trip(CollectionChange::DropDatabase {
            database: "x".into()
        })["kind"],
        "dropDatabase"
    );
    let index = IndexChange::Hide {
        database: "shop".into(),
        collection: "orders".into(),
        name: "a_1".into(),
        hidden: true,
    };
    assert_eq!(round_trip(index)["kind"], "hide");
}

#[test]
fn a_wrong_field_is_refused() {
    let wrong = json!({"connection": "c", "request": {"database": "d", "extra": 1}});
    assert!(serde_json::from_value::<On<DatabaseName>>(wrong).is_err());
    let unknown = json!({"kind": "truncate", "database": "d"});
    assert!(serde_json::from_value::<CollectionChange>(unknown).is_err());
}
