//! The Elasticsearch module against the fixture's Elasticsearch and OpenSearch
//! (`tools/nosql-fixture.sh`): who answers, the tree with an index's fields, SQL by pages
//! that returns what the equivalent search does, the plan, requests of the API, paths that
//! leave the node refused, and an address the egress policy refuses.
mod common;

use common::{Host, driver, driver_with, kv, params};
use nexo_driver_sdk::{
    Value,
    explain::ExplainParams,
    protocol::ObjectParams,
    rest::methods,
    statements::{ExecuteParams, FetchParams},
};
use serde_json::json;

const SERVERS: [(&str, &str); 2] = [("ELASTIC", "Elasticsearch"), ("OPENSEARCH", "OpenSearch")];

#[tokio::test]
async fn both_engines_answer_with_their_tree_and_their_sql() {
    for (server, product) in SERVERS {
        let connect = fixture!(params("es", server));
        let client = driver();
        let info = client.connect(&connect).await.unwrap();
        assert!(info.product.unwrap().starts_with(product), "{server}");
        let tree = |path: &[&str]| {
            let client = client.clone();
            let path = path.iter().map(|part| (*part).to_owned()).collect();
            async move {
                client
                    .tree(&ObjectParams {
                        connection: "es".into(),
                        path,
                    })
                    .await
                    .unwrap()
            }
        };
        let indices = tree(&["indices"]).await;
        let shop = indices.iter().find(|node| node.name == "shop").unwrap();
        assert!(
            shop.detail.as_deref().unwrap().starts_with("3 docs"),
            "{server}"
        );
        let fields = tree(&["indices", "shop"]).await;
        let city = fields
            .iter()
            .find(|node| node.name == "user.address.city")
            .unwrap();
        assert_eq!(city.detail.as_deref(), Some("keyword"));
        assert!(fields.iter().any(|node| node.name == "name.keyword"));
        // SQL by pages of the server's cursor, the same rows as the search.
        let first = client
            .execute(&ExecuteParams {
                connection: "es".into(),
                statement: "q".into(),
                sql: "SELECT name, price FROM shop ORDER BY price".into(),
                params: Vec::new(),
                page_rows: Some(2),
                max_rows: None,
            })
            .await
            .unwrap();
        assert_eq!(first.rows.len(), 2, "{server}");
        assert_eq!(first.rows[0][0], Value::Text("Lamp".into()));
        let rest = client
            .fetch(&FetchParams {
                connection: "es".into(),
                cursor: first.cursor.clone().expect("a cursor"),
                page_rows: None,
            })
            .await
            .unwrap();
        assert_eq!(rest.rows.len(), 1, "{server}");
        let search = json!({"method": "POST", "path": "shop/_search",
            "body": {"query": {"range": {"price": {"gt": 40}}}}});
        let found = kv(&client, methods::REQUEST, "es", search).await.unwrap();
        assert_eq!(found["status"], 200);
        assert_eq!(found["body"]["hits"]["total"]["value"], 2);
        let sql = client
            .execute(&ExecuteParams {
                connection: "es".into(),
                statement: "q2".into(),
                sql: "SELECT count(*) FROM shop WHERE price > 40".into(),
                params: Vec::new(),
                page_rows: None,
                max_rows: None,
            })
            .await
            .unwrap();
        assert_eq!(sql.rows[0][0], Value::Integer(2), "{server}");
        let plan = client
            .explain(&ExplainParams {
                connection: "es".into(),
                statement: "p".into(),
                sql: "SELECT name FROM shop WHERE price > 40".into(),
                params: Vec::new(),
                mode: Default::default(),
                writes: false,
            })
            .await
            .unwrap();
        assert!(plan.original.contains("40"), "{server}: {}", plan.original);
        let ddl = client
            .ddl(&ObjectParams {
                connection: "es".into(),
                path: vec!["indices".into(), "shop".into()],
            })
            .await
            .unwrap();
        assert!(ddl.sql.starts_with("PUT /shop"));
        assert!(!ddl.sql.contains("creation_date"));
    }
}

#[tokio::test]
async fn requests_stay_on_the_node() {
    let connect = fixture!(params("es", "ELASTIC"));
    let client = driver();
    client.connect(&connect).await.unwrap();
    let cat = kv(
        &client,
        methods::REQUEST,
        "es",
        json!({"method": "GET", "path": "_cat/indices?v"}),
    )
    .await
    .unwrap();
    assert!(cat["body"].as_str().unwrap().contains("shop"));
    for path in [
        "http://evil:9200/_search",
        "//evil/_search",
        "/../_search",
        "shop/%2e%2e/x",
    ] {
        let refused = kv(
            &client,
            methods::REQUEST,
            "es",
            json!({"method": "GET", "path": path}),
        )
        .await;
        assert!(refused.is_err(), "{path}");
    }
    let wrong = kv(
        &client,
        methods::REQUEST,
        "es",
        json!({"method": "TRACE", "path": "/"}),
    )
    .await;
    assert!(wrong.is_err());
}

#[tokio::test]
async fn an_address_the_policy_refuses_is_never_connected() {
    let connect = fixture!(params("refused", "ELASTIC"));
    let host = Host::default();
    host.refused
        .lock()
        .unwrap()
        .push(connect.host.clone().unwrap());
    let error = driver_with(host).connect(&connect).await.unwrap_err();
    assert!(error.message.contains("egress policy"), "{error}");
}
