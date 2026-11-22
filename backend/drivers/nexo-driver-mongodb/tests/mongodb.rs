//! The MongoDB driver over the protocol: every server is checked with the host before the
//! library connects to it, a route goes through its proxy by name, and (with the fixture)
//! the `document` extension answers as the built-in adapter did.
mod common;

use common::{Host, call, driver, driver_with, params};
use nexo_driver_sdk::{
    document::{
        ConnectionReport, DatabaseSummary, DocumentPage, WriteResult, methods,
    },
    protocol::{ObjectParams, ProxySettings},
};
use serde_json::{Value as Json, json};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn refuses_seeds_of_the_policy_and_of_secrets_before_connecting() {
    let mut refused = params(
        "a",
        "mongodb://public.test,private.test:27018/?serverSelectionTimeoutMS=100",
    );
    refused.options.insert("checkMembers".into(), "true".into());
    let error = driver().connect(&refused).await.unwrap_err();
    assert_eq!(
        error.message,
        "Nexo may not connect to private.test:27018: Destination private.test is blocked by the egress policy"
    );
    let mut secret = params(
        "b",
        "mongodb://ana@db.other.test/?serverSelectionTimeoutMS=100",
    );
    secret.password = Some("secret".into());
    let host = Host {
        secret: true,
        ..Host::default()
    };
    let error = driver_with(host).connect(&secret).await.unwrap_err();
    assert!(
        error
            .message
            .contains("secret mongo-pass cannot be sent to db.other.test"),
        "{error}"
    );
}

#[tokio::test]
async fn an_unreachable_server_is_explained() {
    // Port 9 (discard) on loopback: nothing answers there.
    let client = driver();
    let uri = "mongodb://127.0.0.1:9/?serverSelectionTimeoutMS=300&connectTimeoutMS=300";
    client.connect(&params("c", uri)).await.unwrap();
    let error = call::<_, ConnectionReport>(&client, methods::REPORT, "c", ())
        .await
        .unwrap_err();
    assert!(error.message.starts_with("No server answered:"), "{error}");
    let unknown = call::<_, Json>(&client, methods::DATABASES, "nobody", ()).await;
    assert!(unknown.unwrap_err().message.contains("not open"));
}

/// A SOCKS5 proxy that signs in `ana`/`pw`, records each destination asked for and then
/// hangs up, as if the destination did not answer.
async fn recording_proxy() -> (u16, Arc<Mutex<Vec<String>>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let asked = Arc::new(Mutex::new(Vec::new()));
    let recorded = asked.clone();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let recorded = recorded.clone();
            tokio::spawn(async move {
                let mut head = [0u8; 2];
                stream.read_exact(&mut head).await?;
                let mut methods = vec![0u8; head[1] as usize];
                stream.read_exact(&mut methods).await?;
                stream.write_all(&[5, 2]).await?;
                let mut version = [0u8; 2];
                stream.read_exact(&mut version).await?;
                let mut user = vec![0u8; version[1] as usize];
                stream.read_exact(&mut user).await?;
                let mut length = [0u8; 1];
                stream.read_exact(&mut length).await?;
                let mut password = vec![0u8; length[0] as usize];
                stream.read_exact(&mut password).await?;
                let ok = user == b"ana" && password == b"pw";
                stream.write_all(&[1, if ok { 0 } else { 1 }]).await?;
                let mut request = [0u8; 5];
                stream.read_exact(&mut request).await?;
                let mut name = vec![0u8; request[4] as usize + 2];
                stream.read_exact(&mut name).await?;
                let port = u16::from_be_bytes([name[name.len() - 2], name[name.len() - 1]]);
                let host = String::from_utf8_lossy(&name[..name.len() - 2]).to_string();
                recorded.lock().unwrap().push(format!("{host}:{port}"));
                Ok::<_, std::io::Error>(())
            });
        }
    });
    (port, asked)
}

#[tokio::test]
async fn connections_with_a_route_go_through_its_proxy_by_name() {
    let (port, asked) = recording_proxy().await;
    let routed = |name: &str, uri: &str| {
        let mut params = params(name, uri);
        params.proxy = Some(ProxySettings {
            host: "127.0.0.1".into(),
            port,
            user: Some("ana".into()),
            password: Some("pw".into()),
        });
        params
    };
    let client = driver();
    let uri = "mongodb://db.internal:27017/?serverSelectionTimeoutMS=300&connectTimeoutMS=300";
    client.connect(&routed("r", uri)).await.unwrap();
    let error = call::<_, ConnectionReport>(&client, methods::REPORT, "r", ())
        .await
        .unwrap_err();
    assert!(error.message.starts_with("No server answered:"), "{error}");
    assert!(
        asked
            .lock()
            .unwrap()
            .contains(&"db.internal:27017".to_string()),
        "{asked:?}"
    );
    let hidden = client
        .connect(&routed("h", "mongodb://hidden.internal"))
        .await
        .unwrap_err();
    assert_eq!(
        hidden.message,
        "Nexo may not connect to hidden.internal:27017: hidden.internal is refused behind the proxy"
    );
}

#[tokio::test]
async fn the_fixture_is_browsed_queried_and_written_through_the_extension() {
    let uri = fixture!();
    let host = Host::default();
    let client = driver_with(host.clone());
    client.connect(&params("p", &uri)).await.unwrap();
    assert!(host.asked.lock().unwrap().contains(&"127.0.0.1:27117".into()));
    let report: ConnectionReport = call(&client, methods::REPORT, "p", ()).await.unwrap();
    assert_eq!(report.topology, "standalone");
    let databases: Vec<DatabaseSummary> = call(&client, methods::DATABASES, "p", ())
        .await
        .unwrap();
    assert!(databases.iter().any(|database| database.name == "nexo"));
    let tree = client
        .tree(&ObjectParams {
            connection: "p".into(),
            path: vec!["nexo".into()],
        })
        .await
        .unwrap();
    assert!(tree.iter().any(|node| node.name == "big"), "{tree:?}");

    let find = json!({"id": "q1", "database": "nexo", "collection": "big", "pageSize": 10});
    let first: DocumentPage = call(&client, methods::FIND, "p", find).await.unwrap();
    assert_eq!(first.documents.len(), 10);
    let cursor = first.cursor.expect("more pages");
    let more = json!({"cursor": cursor, "id": "q1", "pageSize": 10});
    let next: DocumentPage = call(&client, methods::MORE, "p", more).await.unwrap();
    assert_eq!(next.documents.len(), 10);
    assert_ne!(next.documents[0], first.documents[0]);

    let target = json!({"database": "nexo", "collection": "driver_scratch"});
    let insert = json!({"target": target, "write": {"kind": "insert", "documents": [{"n": {"$numberLong": "7"}}]}});
    let written: WriteResult = call(&client, methods::WRITE, "p", insert).await.unwrap();
    assert_eq!(written.inserted.len(), 1);
    assert_eq!(written.changes.len(), 1, "a change to undo travels back");
    let drop = json!({"kind": "drop", "database": "nexo", "collection": "driver_scratch"});
    call::<_, Json>(&client, methods::CHANGE, "p", drop).await.unwrap();
    client.disconnect("p").await.unwrap();
}
