//! Producing and reading records: offsets, partitions and compression.
use super::super::*;
use super::*;

#[tokio::test]
async fn lists_topics_produces_and_reads_messages() {
    let (port, log) = start(Broker::default()).await;
    let mut cluster = Cluster::connect(settings(port)).await.unwrap();
    let topics = cluster.topics().await.unwrap();
    assert_eq!(topics.len(), 1);
    assert_eq!(topics[0].name, "orders");
    assert_eq!(
        topics[0].leaders.keys().copied().collect::<Vec<_>>(),
        [0, 1]
    );

    // A key chooses its partition as Java's producer does.
    let keyed = cluster
        .produce(message("orders", None, Some("21"), "first"))
        .await
        .unwrap();
    let expected = (murmur2(b"21") & 0x7fff_ffff) % 2;
    assert_eq!(keyed["partition"], expected);
    let mut with_headers = message("orders", Some(1), None, "");
    with_headers.value = Some(Bytes::from_static(&[0xff, 0x00]));
    with_headers.headers = vec![("trace".into(), Bytes::from_static(b"abc"))];
    let produced = cluster.produce(with_headers).await.unwrap();
    assert_eq!(produced["partition"], 1);
    cluster
        .produce(message("orders", Some(1), Some("k"), "third"))
        .await
        .unwrap();
    assert!(
        cluster
            .produce(message("orders", Some(7), None, "x"))
            .await
            .is_err()
    );
    assert_eq!(log.lock().unwrap().values().map(Vec::len).sum::<usize>(), 3);

    let mut positions = cluster
        .positions("orders", Some(1), Start::Earliest)
        .await
        .unwrap();
    let read = cluster.fetch("orders", &mut positions).await.unwrap();
    let values: Vec<&Value> = read.iter().map(|message| &message["value"]).collect();
    let first_on_one = if expected == 1 {
        vec![json!("first")]
    } else {
        vec![]
    };
    assert_eq!(
        values,
        first_on_one
            .iter()
            .chain([json!({"$binary": "/wA="}), json!("third")].iter())
            .collect::<Vec<_>>()
    );
    let binary = read
        .iter()
        .find(|message| message["value"].is_object())
        .unwrap();
    assert_eq!(binary["headers"], json!({"trace": "abc"}));
    assert_eq!(binary["key"], Value::Null);
    // Nothing new: nothing read again.
    assert!(
        cluster
            .fetch("orders", &mut positions)
            .await
            .unwrap()
            .is_empty()
    );
    let mut latest = cluster
        .positions("orders", None, Start::Latest)
        .await
        .unwrap();
    assert!(
        cluster
            .fetch("orders", &mut latest)
            .await
            .unwrap()
            .is_empty()
    );
    let mut from = cluster
        .positions("orders", Some(1), Start::Offset(1))
        .await
        .unwrap();
    let after = cluster.fetch("orders", &mut from).await.unwrap();
    assert_eq!(after.last().unwrap()["value"], "third");
    assert!(
        cluster
            .positions("missing", None, Start::Latest)
            .await
            .is_err()
    );
    // Producing to a new topic creates it, as the broker allows.
    let created = cluster
        .produce(message("audit", None, None, "x"))
        .await
        .unwrap();
    assert_eq!(created["topic"], "audit");
}

#[test]
fn starts_values_and_partitions() {
    assert_eq!(Start::from_payload(&json!({})).unwrap(), Start::Latest);
    assert_eq!(
        Start::from_payload(&json!({"from": "earliest"})).unwrap(),
        Start::Earliest
    );
    assert_eq!(
        Start::from_payload(&json!({"from": "offset", "offset": "42"})).unwrap(),
        Start::Offset(42)
    );
    assert!(Start::from_payload(&json!({"from": "offset", "offset": -1})).is_err());
    assert!(Start::from_payload(&json!({"from": "middle"})).is_err());
    assert_eq!(
        bytes_of(r#"{"$binary": "AQI="}"#).unwrap(),
        Bytes::from_static(&[1, 2])
    );
    assert_eq!(
        bytes_of(r#"{"a": 1}"#).unwrap(),
        Bytes::from_static(br#"{"a": 1}"#)
    );
    assert!(bytes_of(r#"{"$binary": "%%"}"#).is_err());
    assert_eq!(
        shown(&Some(Bytes::from_static(&[0xc3]))),
        json!({"$binary": "ww=="})
    );
    // The Java client's own test vectors.
    for (key, hash) in [
        ("21", -973932308),
        ("foobar", -790332482),
        ("a-little-bit-long-string", -985981536),
        ("a-little-bit-longer-string", -1486304829),
        (
            "lkjh234lh9fiuh90y23oiuhsafujhadof229phr9h19h89h8",
            -58897971,
        ),
        ("abc", 479470107),
    ] {
        assert_eq!(murmur2(key.as_bytes()), hash, "{key}");
    }
}

#[test]
fn every_compression_is_read() {
    use kafka_protocol::compression::{Compressor, Gzip, Snappy};
    let data = b"kafka records ".repeat(50);
    let compressed = |compress: fn(&mut BytesMut, &[u8])| {
        let mut out = BytesMut::new();
        compress(&mut out, &data);
        out.freeze()
    };
    let gzip = compressed(|out, data| {
        Gzip::compress(out, |buf: &mut BytesMut| {
            buf.extend_from_slice(data);
            Ok(())
        })
        .unwrap()
    });
    let snappy = compressed(|out, data| {
        Snappy::compress(out, |buf: &mut BytesMut| {
            buf.extend_from_slice(data);
            Ok(())
        })
        .unwrap()
    });
    let mut lz4 = lz4_flex::frame::FrameEncoder::new(Vec::new());
    std::io::Write::write_all(&mut lz4, &data).unwrap();
    let lz4 = Bytes::from(lz4.finish().unwrap());
    let zstd = Bytes::from(ruzstd::encoding::compress_to_vec(
        &data[..],
        ruzstd::encoding::CompressionLevel::Fastest,
    ));
    for (compression, mut buffer) in [
        (Compression::None, Bytes::from(data.clone())),
        (Compression::Gzip, gzip),
        (Compression::Snappy, snappy),
        (Compression::Lz4, lz4),
        (Compression::Zstd, zstd),
    ] {
        assert_eq!(
            decompress(&mut buffer, compression).unwrap(),
            data,
            "{compression:?}"
        );
    }
    assert!(decompress(&mut Bytes::from_static(b"not lz4"), Compression::Lz4).is_err());
}
