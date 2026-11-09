//! The client against a broker that speaks the Kafka protocol through the same codec, and the
//! pieces that need no network.
use super::*;
use kafka_protocol::{
    messages::{
        ApiKey, ApiVersionsRequest, ApiVersionsResponse, FetchResponse, ListOffsetsResponse,
        MetadataResponse, ProduceResponse, ResponseHeader, SaslAuthenticateRequest,
        SaslAuthenticateResponse, SaslHandshakeRequest, SaslHandshakeResponse,
        api_versions_response::ApiVersion,
        fetch_response::{FetchableTopicResponse, PartitionData},
        list_offsets_response::{ListOffsetsPartitionResponse, ListOffsetsTopicResponse},
        metadata_response::{
            MetadataResponseBroker, MetadataResponsePartition, MetadataResponseTopic,
        },
        produce_response::{PartitionProduceResponse, TopicProduceResponse},
    },
    protocol::{Decodable, Encodable, HeaderVersion, decode_request_header_from_buffer},
};
use std::sync::Mutex;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

/// What the test broker accepts and serves.
#[derive(Clone, Default)]
pub(crate) struct Broker {
    /// `(mechanism, user, password)` it requires.
    sasl: Option<(sasl::Mechanism, String, String)>,
    /// Another broker it announces, leading the topic `remote`.
    other: Option<(String, u16)>,
}
pub(crate) type Log = Arc<Mutex<BTreeMap<(String, i32), Vec<Record>>>>;

/// Starts a broker on a free loopback port; topic `orders` has two partitions.
pub(crate) async fn start(broker: Broker) -> (u16, Log) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let log: Log = Arc::default();
    let shared = log.clone();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(serve(stream, broker.clone(), port, shared.clone()));
        }
    });
    (port, log)
}

async fn serve(mut stream: TcpStream, broker: Broker, port: u16, log: Log) {
    let mut scram: Option<(sasl::Scram, String)> = None;
    loop {
        let Ok(length) = stream.read_i32().await else {
            return;
        };
        let mut frame = vec![0u8; length as usize];
        if stream.read_exact(&mut frame).await.is_err() {
            return;
        }
        let mut frame = Bytes::from(frame);
        let header = decode_request_header_from_buffer(&mut frame).unwrap();
        let version = header.request_api_version;
        let key = ApiKey::try_from(header.request_api_key).unwrap();
        let mut body = BytesMut::new();
        macro_rules! answer {
            ($response:expr, $type:ty) => {{
                let mut head = ResponseHeader::default();
                head.correlation_id = header.correlation_id;
                head.encode(&mut body, <$type>::header_version(version))
                    .unwrap();
                $response.encode(&mut body, version).unwrap();
            }};
        }
        match key {
            ApiKey::ApiVersions => {
                ApiVersionsRequest::decode(&mut frame, version).unwrap();
                let mut response = ApiVersionsResponse::default();
                for (key, min, max) in [
                    (ApiKey::ApiVersions, 0, 3),
                    (ApiKey::Metadata, 1, 12),
                    (ApiKey::Produce, 3, 9),
                    (ApiKey::Fetch, 4, 12),
                    (ApiKey::ListOffsets, 1, 7),
                    (ApiKey::SaslHandshake, 0, 1),
                    (ApiKey::SaslAuthenticate, 0, 2),
                ] {
                    let mut range = ApiVersion::default();
                    range.api_key = key as i16;
                    range.min_version = min;
                    range.max_version = max;
                    response.api_keys.push(range);
                }
                answer!(response, ApiVersionsResponse)
            }
            ApiKey::SaslHandshake => {
                let request = SaslHandshakeRequest::decode(&mut frame, version).unwrap();
                let mut response = SaslHandshakeResponse::default();
                let accepted = broker.sasl.as_ref().map(|(mechanism, ..)| mechanism.name());
                response.mechanisms = accepted
                    .into_iter()
                    .map(StrBytes::from_static_str)
                    .collect();
                if accepted != Some(request.mechanism.as_str()) {
                    response.error_code = 33;
                }
                answer!(response, SaslHandshakeResponse)
            }
            ApiKey::SaslAuthenticate => {
                let request = SaslAuthenticateRequest::decode(&mut frame, version).unwrap();
                let (mechanism, user, password) = broker.sasl.clone().unwrap();
                let text = String::from_utf8_lossy(&request.auth_bytes).to_string();
                let mut response = SaslAuthenticateResponse::default();
                let fail = |response: &mut SaslAuthenticateResponse| {
                    response.error_code = 58;
                    response.error_message = Some(StrBytes::from_static_str("bad credentials"));
                };
                match (mechanism, scram.take()) {
                    (sasl::Mechanism::Plain, _) => {
                        if request.auth_bytes != sasl::plain(&user, &password) {
                            fail(&mut response);
                        }
                    }
                    (_, None) => {
                        let nonce = text.split(",r=").nth(1).unwrap_or_default().to_string();
                        let server_first = format!("r={nonce}server,s=c2FsdA==,i=4096");
                        response.auth_bytes = Bytes::from(server_first.clone());
                        scram = Some((
                            sasl::Scram::new(mechanism, &user, &password, nonce),
                            server_first,
                        ));
                    }
                    (_, Some((mut expected, server_first))) => {
                        if expected.client_final(&server_first).unwrap() == text {
                            response.auth_bytes = Bytes::from(expected.server_final().unwrap());
                        } else {
                            fail(&mut response);
                        }
                    }
                }
                answer!(response, SaslAuthenticateResponse)
            }
            ApiKey::Metadata => {
                let request = MetadataRequest::decode(&mut frame, version).unwrap();
                let mut response = MetadataResponse::default();
                let mut me = MetadataResponseBroker::default();
                me.node_id = BrokerId(1);
                me.host = StrBytes::from_static_str("127.0.0.1");
                me.port = port as i32;
                response.brokers.push(me);
                let mut topics = vec![("orders".to_string(), 1, 2)];
                if let Some((host, other_port)) = &broker.other {
                    let mut other = MetadataResponseBroker::default();
                    other.node_id = BrokerId(2);
                    other.host = StrBytes::from_string(host.clone());
                    other.port = *other_port as i32;
                    response.brokers.push(other);
                    topics.push(("remote".to_string(), 2, 1));
                }
                // Asked by name: unknown topics are created when allowed.
                if let Some(asked) = &request.topics {
                    for name in asked.iter().filter_map(|topic| topic.name.as_ref()) {
                        let name = name.0.to_string();
                        if !topics.iter().any(|(known, ..)| *known == name) {
                            topics.push((
                                name,
                                if request.allow_auto_topic_creation {
                                    1
                                } else {
                                    -1
                                },
                                1,
                            ));
                        }
                    }
                }
                for (name, leader, partitions) in topics {
                    let mut topic = MetadataResponseTopic::default();
                    topic.name = Some(TopicName(StrBytes::from_string(name)));
                    if leader < 0 {
                        topic.error_code = 3;
                    } else {
                        topic.partitions = (0..partitions)
                            .map(|index| {
                                let mut partition = MetadataResponsePartition::default();
                                partition.partition_index = index;
                                partition.leader_id = BrokerId(leader);
                                partition
                            })
                            .collect();
                    }
                    response.topics.push(topic);
                }
                answer!(response, MetadataResponse)
            }
            ApiKey::Produce => {
                let request = ProduceRequest::decode(&mut frame, version).unwrap();
                let mut response = ProduceResponse::default();
                for topic in request.topic_data {
                    let mut answered = TopicProduceResponse::default();
                    answered.name = topic.name.clone();
                    for data in topic.partition_data {
                        let mut records = data.records.unwrap();
                        let batch = RecordBatchDecoder::decode(&mut records).unwrap();
                        let mut log = log.lock().unwrap();
                        let stored = log
                            .entry((topic.name.0.to_string(), data.index))
                            .or_default();
                        let base = stored.len() as i64;
                        for (index, mut record) in batch.records.into_iter().enumerate() {
                            record.offset = base + index as i64;
                            stored.push(record);
                        }
                        let mut partition = PartitionProduceResponse::default();
                        partition.index = data.index;
                        partition.base_offset = base;
                        answered.partition_responses.push(partition);
                    }
                    response.responses.push(answered);
                }
                answer!(response, ProduceResponse)
            }
            ApiKey::ListOffsets => {
                let request = ListOffsetsRequest::decode(&mut frame, version).unwrap();
                let mut response = ListOffsetsResponse::default();
                for topic in request.topics {
                    let mut answered = ListOffsetsTopicResponse::default();
                    answered.name = topic.name.clone();
                    for partition in topic.partitions {
                        let length = log
                            .lock()
                            .unwrap()
                            .get(&(topic.name.0.to_string(), partition.partition_index))
                            .map_or(0, Vec::len) as i64;
                        let mut offset = ListOffsetsPartitionResponse::default();
                        offset.partition_index = partition.partition_index;
                        offset.offset = if partition.timestamp == -2 { 0 } else { length };
                        answered.partitions.push(offset);
                    }
                    response.topics.push(answered);
                }
                answer!(response, ListOffsetsResponse)
            }
            ApiKey::Fetch => {
                let request = FetchRequest::decode(&mut frame, version).unwrap();
                let mut response = FetchResponse::default();
                for topic in request.topics {
                    let mut answered = FetchableTopicResponse::default();
                    answered.topic = topic.topic.clone();
                    for wanted in topic.partitions {
                        let stored: Vec<Record> = log
                            .lock()
                            .unwrap()
                            .get(&(topic.topic.0.to_string(), wanted.partition))
                            .map(|records| {
                                records
                                    .iter()
                                    .filter(|record| record.offset >= wanted.fetch_offset)
                                    .cloned()
                                    .collect()
                            })
                            .unwrap_or_default();
                        let mut data = PartitionData::default();
                        data.partition_index = wanted.partition;
                        if !stored.is_empty() {
                            let mut batch = BytesMut::new();
                            RecordBatchEncoder::encode(
                                &mut batch,
                                stored.iter(),
                                &RecordEncodeOptions {
                                    version: 2,
                                    compression: Compression::Gzip,
                                },
                            )
                            .unwrap();
                            data.records = Some(batch.freeze());
                        }
                        answered.partitions.push(data);
                    }
                    response.responses.push(answered);
                }
                answer!(response, FetchResponse)
            }
            other => panic!("unexpected request {other:?}"),
        }
        if stream.write_i32(body.len() as i32).await.is_err()
            || stream.write_all(&body).await.is_err()
        {
            return;
        }
    }
}

fn settings(port: u16) -> Settings {
    Settings {
        bootstrap: vec![("127.0.0.1".into(), port)],
        tls: None,
        sasl: None,
        client_id: "nexo-test".into(),
        egress: Policy::AllowAll,
        loopback_ports: Vec::new(),
        restricted: Vec::new(),
    }
}
fn message(topic: &str, partition: Option<i32>, key: Option<&str>, value: &str) -> Outgoing {
    Outgoing {
        topic: topic.into(),
        partition,
        key: key.map(|key| Bytes::from(key.to_string())),
        value: Some(Bytes::from(value.to_string())),
        headers: Vec::new(),
    }
}

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

#[tokio::test]
async fn authenticates_with_scram_and_plain() {
    for mechanism in [
        sasl::Mechanism::ScramSha256,
        sasl::Mechanism::ScramSha512,
        sasl::Mechanism::Plain,
    ] {
        let (port, _) = start(Broker {
            sasl: Some((mechanism, "alice".into(), "s3cret".into())),
            other: None,
        })
        .await;
        let with = |password: &str| Settings {
            sasl: Some(Sasl {
                mechanism,
                username: "alice".into(),
                password: password.into(),
            }),
            ..settings(port)
        };
        let mut cluster = Cluster::connect(with("s3cret")).await.unwrap();
        cluster
            .produce(message("orders", Some(0), None, "hi"))
            .await
            .unwrap();
        let error = Cluster::connect(with("wrong"))
            .await
            .err()
            .unwrap()
            .to_string();
        assert!(
            error.contains("SaslAuthenticationFailed") || error.contains("bad credentials"),
            "{error}"
        );
        let none = Cluster::connect(settings(port)).await;
        assert!(
            none.is_ok(),
            "the broker does not require it from unauthenticated clients"
        );
    }
    let (port, _) = start(Broker {
        sasl: Some((sasl::Mechanism::Plain, "alice".into(), "p".into())),
        other: None,
    })
    .await;
    let refused = Cluster::connect(Settings {
        sasl: Some(Sasl {
            mechanism: sasl::Mechanism::ScramSha256,
            username: "alice".into(),
            password: "p".into(),
        }),
        ..settings(port)
    })
    .await
    .err()
    .unwrap()
    .to_string();
    assert!(
        refused.contains("does not accept SCRAM-SHA-256; it accepts PLAIN"),
        "{refused}"
    );
}

#[tokio::test]
async fn announced_brokers_pass_the_egress_policy_and_secret_hosts() {
    let (port, _) = start(Broker {
        sasl: None,
        other: Some(("10.20.30.40".into(), 9092)),
    })
    .await;
    // The bootstrap broker is the user's own loopback service; the one it announces is not.
    let mut cluster = Cluster::connect(Settings {
        egress: Policy::DenyPrivate { allow: Vec::new() },
        loopback_ports: vec![port],
        ..settings(port)
    })
    .await
    .unwrap();
    cluster
        .produce(message("orders", Some(0), None, "ok"))
        .await
        .unwrap();
    let blocked = cluster
        .produce(message("remote", Some(0), None, "no"))
        .await
        .unwrap_err()
        .to_string();
    assert!(blocked.contains("egress policy"), "{blocked}");

    let restricted = Settings {
        sasl: Some(Sasl {
            mechanism: sasl::Mechanism::Plain,
            username: "u".into(),
            password: "vault-value".into(),
        }),
        restricted: vec![Restricted {
            name: "kafka".into(),
            value: "vault-value".into(),
            hosts: nexo_domain::hosts::AllowedHosts::stored(&["kafka.example.com"]),
        }],
        ..settings(port)
    };
    let denied = Cluster::connect(restricted)
        .await
        .err()
        .unwrap()
        .to_string();
    assert!(
        denied.contains("Secret kafka cannot be sent to 127.0.0.1"),
        "{denied}"
    );
}

#[test]
fn settings_come_from_the_payload_with_vault_secrets() {
    let payload = json!({
        "url": "kafka://broker-1:9093, broker-2 ,[::1]:19092",
        "saslMechanism": "SCRAM-SHA-512",
        "username": "app",
        "password": "{{vault:kafka}}",
        "resolvedSecrets": {"kafka": "from-vault"},
        "secretHosts": {"kafka": ["*.example.com"]},
        "clientId": "orders-tool",
    });
    let settings = Settings::from_payload(&payload, Policy::AllowAll, Vec::new()).unwrap();
    assert_eq!(
        settings.bootstrap,
        [
            ("broker-1".to_string(), 9093),
            ("broker-2".to_string(), 9092),
            ("::1".to_string(), 19092)
        ]
    );
    let credentials = settings.sasl.as_ref().unwrap();
    assert_eq!(credentials.password, "from-vault");
    assert_eq!(credentials.mechanism, sasl::Mechanism::ScramSha512);
    assert_eq!(settings.client_id, "orders-tool");
    assert!(settings.check_host("kafka.example.com").is_ok());
    assert!(settings.check_host("evil.test").is_err());
    assert!(settings.tls.is_none());
    let tls = Settings::from_payload(
        &json!({"url": "b:1", "tls": true}),
        Policy::AllowAll,
        Vec::new(),
    )
    .unwrap();
    assert!(tls.tls.is_some() && tls.sasl.is_none());
    for (payload, error) in [
        (json!({"url": " , "}), "bootstrap servers"),
        (json!({"url": "b:x9"}), "Invalid broker"),
        (
            json!({"url": "b", "saslMechanism": "PLAIN"}),
            "SASL user name",
        ),
        (
            json!({"url": "b", "saslMechanism": "GSSAPI", "username": "u"}),
            "Unsupported SASL",
        ),
    ] {
        let message = Settings::from_payload(&payload, Policy::AllowAll, Vec::new())
            .err()
            .unwrap()
            .to_string();
        assert!(message.contains(error), "{payload}: {message}");
    }
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
