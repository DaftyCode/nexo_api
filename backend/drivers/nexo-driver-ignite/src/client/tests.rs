//! The connection against a node played in memory: the handshake, answers out of order,
//! errors, notifications and a node that goes away.
use super::*;
use nexo_driver_sdk::ErrorCode;
use tokio::io::DuplexStream;

fn uuid(bytes: &mut Vec<u8>) {
    bytes.extend([0xd8, 3]);
    bytes.extend([0; 16]);
}

fn greeting(idle_ms: i64) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut head = Writer::default();
    head.int(3).int(0).int(0).nil().int(idle_ms);
    bytes.extend(head.into_bytes());
    uuid(&mut bytes);
    let mut middle = Writer::default();
    middle.str("node-1").int(1);
    bytes.extend(middle.into_bytes());
    uuid(&mut bytes);
    let mut rest = Writer::default();
    rest.str("nexo")
        .int(5)
        .int(3)
        .int(1)
        .int(0)
        .nil()
        .nil()
        .bin(&[])
        .int(0);
    bytes.extend(rest.into_bytes());
    bytes
}

/// The node's side: greets the client and hands back the socket.
async fn node(idle_ms: i64) -> (Client, DuplexStream) {
    let (client_side, mut node_side) = tokio::io::duplex(1 << 16);
    let greet = async move {
        let mut magic = [0u8; 4];
        node_side.read_exact(&mut magic).await.unwrap();
        assert_eq!(&magic, MAGIC);
        read_frame(&mut node_side).await.unwrap();
        node_side.write_all(MAGIC).await.unwrap();
        node_side
            .write_all(&frame(&greeting(idle_ms)))
            .await
            .unwrap();
        node_side
    };
    let (client, node_side) = tokio::join!(
        Client::start(Box::new(client_side), false, None, None),
        greet
    );
    (client.unwrap(), node_side)
}

/// The operation and id of a request.
async fn request(node: &mut DuplexStream) -> (i64, i64, Vec<u8>) {
    let bytes = read_frame(node).await.unwrap();
    let mut reader = Reader::new(&bytes);
    let (operation, id) = (reader.int().unwrap(), reader.int().unwrap());
    (operation, id, reader.rest().to_vec())
}

async fn reply(node: &mut DuplexStream, id: i64, flags: i64, observed: i64, body: &[u8]) {
    let mut writer = Writer::default();
    writer.int(id).int(flags);
    if flags & PARTITIONS_CHANGED != 0 {
        writer.int(99);
    }
    writer.int(observed);
    let mut bytes = writer.into_bytes();
    bytes.extend(body);
    node.write_all(&frame(&bytes)).await.unwrap();
}

#[tokio::test]
async fn answers_reach_their_requests_in_any_order() {
    let (client, mut node) = node(0).await;
    assert_eq!(client.node.name, "node-1");
    assert_eq!(client.observed(), 5);
    let client = Arc::new(client);
    let (first, second) = (client.clone(), client.clone());
    let one = tokio::spawn(async move {
        first
            .call(50, |writer| {
                writer.str("one");
            })
            .await
    });
    let (operation, one_id, body) = request(&mut node).await;
    assert_eq!(operation, 50);
    assert_eq!(Reader::new(&body).str().unwrap(), "one");
    let two = tokio::spawn(async move { second.call(51, |_| {}).await });
    let (_, two_id, _) = request(&mut node).await;
    // A notification first, then the second answer before the first one.
    reply(&mut node, 0, NOTIFICATION, 6, &[]).await;
    reply(&mut node, two_id, PARTITIONS_CHANGED, 7, &[0x02]).await;
    reply(&mut node, one_id, 0, 8, &[0x01]).await;
    assert_eq!(two.await.unwrap().unwrap(), [0x02]);
    assert_eq!(one.await.unwrap().unwrap(), [0x01]);
    assert_eq!(client.observed(), 8);
}

#[tokio::test]
async fn an_error_answers_its_request_and_a_closed_node_ends_the_rest() {
    let (client, mut node) = node(0).await;
    let client = Arc::new(client);
    let asking = client.clone();
    let failing = tokio::spawn(async move { asking.call(50, |_| {}).await });
    let (_, id, _) = request(&mut node).await;
    let mut error = Vec::new();
    uuid(&mut error);
    let mut rest = Writer::default();
    rest.int(4 << 16 | 3)
        .str("org.apache.ignite.sql.SqlException")
        .str("IGN-SQL-3 TraceId:1 Failed to parse query")
        .nil()
        .nil();
    error.extend(rest.into_bytes());
    reply(&mut node, id, ERROR, 9, &error).await;
    let failed = failing.await.unwrap().unwrap_err();
    assert_eq!(failed.code, ErrorCode::Syntax);
    let asking = client.clone();
    let waiting = tokio::spawn(async move { asking.call(50, |_| {}).await });
    request(&mut node).await;
    drop(node);
    assert_eq!(waiting.await.unwrap().unwrap_err().code, ErrorCode::Closed);
    assert!(client.is_closed());
    assert_eq!(
        client.call(1, |_| {}).await.unwrap_err().code,
        ErrorCode::Closed
    );
    client.close().await;
}

#[tokio::test]
async fn an_idle_node_gets_heartbeats() {
    let (client, mut node) = node(1500).await;
    let client = Arc::new(client);
    client.keep_alive();
    let (operation, id, _) = request(&mut node).await;
    assert_eq!(operation, HEARTBEAT);
    reply(&mut node, id, 0, 10, &[]).await;
    drop(client);
}

#[tokio::test]
async fn a_server_that_is_not_ignite_is_refused() {
    let (client_side, mut other) = tokio::io::duplex(1 << 12);
    let answer = async move {
        let mut magic = [0u8; 4];
        other.read_exact(&mut magic).await.unwrap();
        other.write_all(b"HTTP").await.unwrap();
        other
    };
    let (refused, _other) = tokio::join!(
        Client::start(Box::new(client_side), false, None, None),
        answer
    );
    assert_eq!(refused.err().unwrap().code, ErrorCode::Network);
    let mut huge = Vec::new();
    huge.extend(((MAX_MESSAGE + 1) as u32).to_be_bytes());
    assert!(read_frame(&mut huge.as_slice()).await.is_err());
}
