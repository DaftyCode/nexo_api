//! The Redis module against the fixture's Redis and Valkey (`tools/nosql-fixture.sh`): the
//! server, keys by pages of SCAN (never KEYS), and each type read by its shape.
mod common;

use common::{driver, kv, params};
use nexo_driver_sdk::{Value, keyvalue::methods, protocol::ObjectParams};
use serde_json::{Value as Json, json};

const SERVERS: [&str; 2] = ["REDIS", "VALKEY"];

/// Every key a scan finds, page after page.
async fn every(client: &nexo_driver_sdk::Client, mut params: Json) -> Vec<Json> {
    let mut found = Vec::new();
    loop {
        let page = kv(client, methods::SCAN, "scan", params.clone())
            .await
            .unwrap();
        found.extend(page["keys"].as_array().unwrap().iter().cloned());
        if page["cursor"].is_null() {
            return found;
        }
        params["cursor"] = page["cursor"].clone();
    }
}

#[tokio::test]
async fn both_servers_say_what_they_are_and_list_their_databases() {
    for (server, product) in SERVERS.iter().zip(["Redis", "Valkey"]) {
        let connect = fixture!(params("info", server));
        let client = driver();
        let info = client.connect(&connect).await.unwrap();
        assert!(info.product.unwrap().starts_with(product), "{server}");
        assert_eq!(info.database.as_deref(), Some("db0"));
        let databases = client
            .tree(&ObjectParams {
                connection: "info".into(),
                path: vec![],
            })
            .await
            .unwrap();
        assert_eq!(databases[0].name, "db0");
        assert!(databases[0].detail.as_deref().unwrap().ends_with("keys"));
    }
}

#[tokio::test]
async fn keys_come_by_pages_of_scan_and_never_with_keys() {
    let connect = fixture!(params("scan", "REDIS"));
    let client = driver();
    client.connect(&connect).await.unwrap();
    let first = kv(&client, methods::SCAN, "scan", json!({"count": 500}))
        .await
        .unwrap();
    let page = first["keys"].as_array().unwrap().len();
    assert!((500..100_000).contains(&page), "{page}");
    assert!(first["cursor"].is_string());
    // A pattern, followed to its end.
    let mut found: Vec<String> = every(&client, json!({"pattern": "bulk:9999*", "count": 1000}))
        .await
        .iter()
        .map(|key| key["key"].as_str().unwrap().to_owned())
        .collect();
    found.sort();
    found.dedup();
    let expected: Vec<String> = std::iter::once("bulk:9999".to_owned())
        .chain((0..10).map(|n| format!("bulk:9999{n}")))
        .collect();
    assert_eq!(found, expected);
    let typed = json!({"pattern": "*", "type": "zset", "count": 1000});
    let typed = kv(&client, methods::SCAN, "scan", typed).await.unwrap();
    let typed = typed["keys"].as_array().unwrap();
    assert!(typed.iter().all(|key| key["type"] == "zset"));
    let expiring = every(&client, json!({"pattern": "session:*", "count": 5000})).await;
    assert!(expiring[0]["ttlMs"].as_i64().unwrap() > 0);
    // The server never saw a KEYS.
    let stats = json!({"args": ["INFO", "commandstats"]});
    let stats = kv(&client, methods::COMMAND, "scan", stats).await.unwrap();
    assert!(!stats["reply"].as_str().unwrap().contains("cmdstat_keys:"));
}

#[tokio::test]
async fn each_type_is_read_by_its_shape() {
    for server in SERVERS {
        let connect = fixture!(params("types", server));
        let client = driver();
        client.connect(&connect).await.unwrap();
        let get = |key: &str, extra: Json| {
            let client = client.clone();
            let mut params = json!({"key": key});
            let extra = extra.as_object().unwrap().clone();
            params.as_object_mut().unwrap().extend(extra);
            async move { kv(&client, methods::GET, "types", params).await.unwrap() }
        };
        assert_eq!(get("user:1:name", json!({})).await["value"], "Ana");
        let binary = get("bin:1", json!({})).await;
        let bytes = Value::try_from(binary["value"].clone()).unwrap();
        assert_eq!(bytes.as_bytes().unwrap(), [0xff, 0, b'b', b'i', b'n']);
        let list = get("queue:jobs", json!({"count": 2})).await;
        assert_eq!(list["length"], 3);
        let first = json!([{"index": 0, "value": "a"}, {"index": 1, "value": "b"}]);
        assert_eq!(list["elements"], first);
        let rest = get("queue:jobs", json!({"count": 2, "cursor": list["cursor"]})).await;
        assert_eq!(rest["elements"], json!([{"index": 2, "value": "c"}]));
        assert!(rest["cursor"].is_null());
        let zset = get("scores", json!({})).await;
        let scores = json!([{"score": 1.5, "value": "ana"}, {"score": 3.0, "value": "luis"}]);
        assert_eq!(zset["elements"], scores);
        let hash = get("user:1", json!({})).await;
        assert_eq!(hash["length"], 2);
        let city = json!({"field": "city", "value": "Lima"});
        assert!(hash["elements"].as_array().unwrap().contains(&city));
        let set = get("tags", json!({})).await;
        assert_eq!(set["elements"].as_array().unwrap().len(), 2);
        let stream = get("events", json!({})).await;
        let entry = &stream["elements"][0];
        assert!(entry["id"].as_str().unwrap().contains('-'));
        let fields = json!({"$t": "json", "v": "{\"kind\":\"login\",\"user\":\"ana\"}"});
        assert_eq!(entry["value"], fields);
        assert!(get("session:1", json!({})).await["ttlMs"].as_i64().unwrap() > 0);
        let missing = json!({"key": "no:such:key"});
        assert!(kv(&client, methods::GET, "types", missing).await.is_err());
    }
}
