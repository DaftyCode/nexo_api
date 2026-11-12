//! A broker speaking the Kafka wire protocol, for the tests.
use super::super::*;
use super::*;

/// What the test broker accepts and serves.
#[derive(Clone, Default)]
pub(crate) struct Broker {
    /// `(mechanism, user, password)` it requires.
    pub(super) sasl: Option<(sasl::Mechanism, String, String)>,
    /// Another broker it announces, leading the topic `remote`.
    pub(super) other: Option<(String, u16)>,
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

pub(super) async fn serve(mut stream: TcpStream, broker: Broker, port: u16, log: Log) {
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
