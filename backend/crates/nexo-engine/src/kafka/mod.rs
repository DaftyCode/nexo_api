//! A Kafka client for the protocols panel: topics and partitions, producing messages with key,
//! headers and partition, and reading a topic from its start, its end or an offset.
//!
//! Only the wire codec comes from `kafka-protocol`. Connections are this crate's: every broker,
//! the bootstrap ones and those the cluster metadata announces, is checked against the egress
//! policy before connecting, TLS uses aws-lc-rs like every other protocol, and SASL (PLAIN,
//! SCRAM-SHA-256/512) uses the password from the vault, restricted to its allowed hosts.
//! Consumer groups and Schema Registry are not part of it.
mod connection;
pub mod sasl;

use crate::{egress::Policy, secret_hosts::Restricted};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use bytes::{Bytes, BytesMut};
use connection::{Connection, error_of};
use indexmap::IndexMap;
use kafka_protocol::{
    messages::{
        BrokerId, FetchRequest, ListOffsetsRequest, MetadataRequest, ProduceRequest, TopicName,
        fetch_request::{FetchPartition, FetchTopic},
        list_offsets_request::{ListOffsetsPartition, ListOffsetsTopic},
        metadata_request::MetadataRequestTopic,
        produce_request::{PartitionProduceData, TopicProduceData},
    },
    protocol::StrBytes,
    records::{
        Compression, Record, RecordBatchDecoder, RecordBatchEncoder, RecordEncodeOptions,
        TimestampType,
    },
};
use nexo_domain::{Error, Result};
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    io::Read,
    sync::Arc,
};

/// Newest versions Nexo uses; later ones identify topics by id rather than by name.
const METADATA_VERSION: i16 = 12;
const PRODUCE_VERSION: i16 = 9;
const FETCH_VERSION: i16 = 12;
const LIST_OFFSETS_VERSION: i16 = 7;
/// How long a fetch waits for new messages, and how much it takes.
const FETCH_WAIT_MS: i32 = 500;
const FETCH_BYTES: i32 = 4 * 1024 * 1024;
const PARTITION_BYTES: i32 = 1024 * 1024;
/// The most messages one fetch shows, and the most a batch may grow to once decompressed.
const MAX_MESSAGES: usize = 500;
const MAX_DECOMPRESSED: u64 = 64 * 1024 * 1024;
/// `NOT_LEADER_OR_FOLLOWER` and `LEADER_NOT_AVAILABLE`: the metadata is out of date.
const STALE_LEADER: [i16; 2] = [6, 5];

fn invalid(message: impl Into<String>) -> Error {
    Error::Validation(message.into())
}

/// SASL credentials, with the vault references already replaced.
pub struct Sasl {
    pub mechanism: sasl::Mechanism,
    pub username: String,
    pub password: String,
}

/// How to reach the cluster.
pub struct Settings {
    pub bootstrap: Vec<(String, u16)>,
    pub tls: Option<Arc<rustls::ClientConfig>>,
    pub sasl: Option<Sasl>,
    pub client_id: String,
    pub egress: Policy,
    pub loopback_ports: Vec<u16>,
    /// Vault secrets in the credentials that may only go to some hosts.
    restricted: Vec<Restricted>,
}
impl Settings {
    /// From a `realtime.connect` payload: `url` lists the bootstrap brokers (`host:port`,
    /// separated by commas, `kafka://` optional), `tls`, `saslMechanism`, `username` and
    /// `password` (`{{vault:name}}` references resolved by the application).
    pub fn from_payload(payload: &Value, egress: Policy, loopback_ports: Vec<u16>) -> Result<Self> {
        let bootstrap = bootstrap(payload["url"].as_str().unwrap_or_default())?;
        let secrets: Map<String, Value> = payload["resolvedSecrets"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(name, value)| (format!("vault:{name}"), value.clone()))
            .collect();
        let credential =
            |name: &str| crate::scripts::fill(payload[name].as_str().unwrap_or_default(), &secrets);
        let referenced =
            nexo_application::vault_references(&json!([payload["username"], payload["password"]]));
        let restricted = crate::secret_hosts::restricted(payload)
            .into_iter()
            .filter(|secret| referenced.contains(&secret.name))
            .collect();
        let sasl = match sasl::Mechanism::from_name(
            payload["saslMechanism"].as_str().unwrap_or_default(),
        )? {
            Some(mechanism) => {
                let username = credential("username");
                if username.trim().is_empty() {
                    return Err(invalid("Enter the SASL user name"));
                }
                Some(Sasl {
                    mechanism,
                    username,
                    password: credential("password"),
                })
            }
            None => None,
        };
        let tls = if payload["tls"] == true {
            Some(crate::tls::client_config(payload)?)
        } else {
            None
        };
        Ok(Self {
            bootstrap,
            tls,
            sasl,
            client_id: payload["clientId"]
                .as_str()
                .filter(|id| !id.trim().is_empty())
                .unwrap_or("nexo")
                .to_string(),
            egress,
            loopback_ports,
            restricted,
        })
    }
    /// Fails when the credentials hold a vault secret that may not go to this broker.
    fn check_host(&self, host: &str) -> Result<()> {
        if self.sasl.is_none() {
            return Ok(());
        }
        match self
            .restricted
            .iter()
            .find(|secret| !secret.hosts.allows(host))
        {
            Some(secret) => Err(crate::secret_hosts::denied(&secret.name, host)),
            None => Ok(()),
        }
    }
}

/// The bootstrap brokers of `host:port, host:port`, port 9092 when left out.
fn bootstrap(text: &str) -> Result<Vec<(String, u16)>> {
    let brokers: Vec<(String, u16)> = text
        .split(',')
        .map(str::trim)
        .filter(|broker| !broker.is_empty())
        .map(|broker| {
            let broker = broker
                .strip_prefix("kafka://")
                .unwrap_or(broker)
                .trim_end_matches('/');
            // `[::1]:9092`, `host:9092`, `host`, or a bare IPv6 address.
            let port_of = |port: &str| {
                port.parse::<u16>()
                    .map_err(|_| invalid(format!("Invalid broker port in {broker}")))
            };
            let (host, port) = if let Some(rest) = broker.strip_prefix('[') {
                let (host, after) = rest
                    .split_once(']')
                    .ok_or_else(|| invalid(format!("Invalid broker {broker}")))?;
                match after.strip_prefix(':') {
                    Some(port) => (host, port_of(port)?),
                    None if after.is_empty() => (host, 9092),
                    None => return Err(invalid(format!("Invalid broker {broker}"))),
                }
            } else {
                match broker.matches(':').count() {
                    0 => (broker, 9092),
                    1 => {
                        let (host, port) = broker.split_once(':').expect("one colon");
                        (host, port_of(port)?)
                    }
                    _ => (broker, 9092),
                }
            };
            if host.is_empty() {
                return Err(invalid(format!("Invalid broker {broker}")));
            }
            Ok((host.to_string(), port))
        })
        .collect::<Result<_>>()?;
    if brokers.is_empty() {
        return Err(invalid("Enter the bootstrap servers (host:port)"));
    }
    Ok(brokers)
}

/// A topic and its partitions, with the broker that leads each one.
#[derive(Clone, Debug, PartialEq)]
pub struct Topic {
    pub name: String,
    pub internal: bool,
    pub leaders: BTreeMap<i32, i32>,
}

/// A message to produce.
pub struct Outgoing {
    pub topic: String,
    pub partition: Option<i32>,
    pub key: Option<Bytes>,
    pub value: Option<Bytes>,
    pub headers: Vec<(String, Bytes)>,
}

/// Where reading a topic starts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Start {
    Earliest,
    Latest,
    Offset(i64),
}
impl Start {
    pub fn from_payload(payload: &Value) -> Result<Self> {
        match payload["from"].as_str().unwrap_or("latest") {
            "earliest" => Ok(Self::Earliest),
            "latest" | "" => Ok(Self::Latest),
            "offset" => payload["offset"]
                .as_i64()
                .or_else(|| {
                    payload["offset"]
                        .as_str()
                        .and_then(|text| text.trim().parse().ok())
                })
                .filter(|offset| *offset >= 0)
                .map(Self::Offset)
                .ok_or_else(|| invalid("Enter the offset to start from")),
            other => Err(invalid(format!("Unknown start {other}"))),
        }
    }
}

/// A cluster: the bootstrap connection for metadata and one connection per broker.
pub struct Cluster {
    settings: Settings,
    metadata: Connection,
    brokers: HashMap<i32, (String, u16)>,
    connections: HashMap<i32, Connection>,
    topics: BTreeMap<String, Topic>,
    next_partition: usize,
}
impl Cluster {
    /// Connects to the first bootstrap broker that answers and reads the cluster metadata.
    pub async fn connect(settings: Settings) -> Result<Self> {
        let mut failures = Vec::new();
        let mut opened = None;
        for (host, port) in &settings.bootstrap {
            match Connection::open(&settings, host, *port).await {
                Ok(connection) => {
                    opened = Some(connection);
                    break;
                }
                Err(error) => failures.push(error.to_string()),
            }
        }
        let metadata = opened.ok_or_else(|| invalid(failures.join("; ")))?;
        let mut cluster = Self {
            settings,
            metadata,
            brokers: HashMap::new(),
            connections: HashMap::new(),
            topics: BTreeMap::new(),
            next_partition: 0,
        };
        cluster.refresh(None, false).await?;
        Ok(cluster)
    }

    /// Reads the metadata of some topics (or all), creating them when the broker allows it.
    async fn refresh(&mut self, topics: Option<&[String]>, create: bool) -> Result<()> {
        let mut request = MetadataRequest::default();
        request.topics = topics.map(|names| {
            names
                .iter()
                .map(|name| {
                    let mut topic = MetadataRequestTopic::default();
                    topic.name = Some(TopicName(StrBytes::from_string(name.clone())));
                    topic
                })
                .collect()
        });
        request.allow_auto_topic_creation = create;
        let response = self.metadata.call(&request, METADATA_VERSION).await?;
        self.brokers = response
            .brokers
            .iter()
            .map(|broker| {
                (
                    broker.node_id.0,
                    (broker.host.to_string(), broker.port as u16),
                )
            })
            .collect();
        for topic in response.topics {
            let Some(name) = topic.name.map(|name| name.0.to_string()) else {
                continue;
            };
            if topic.error_code != 0 {
                self.topics.remove(&name);
                if topics.is_some() {
                    return Err(error_of(topic.error_code, Some(name)));
                }
                continue;
            }
            let leaders = topic
                .partitions
                .iter()
                .map(|partition| (partition.partition_index, partition.leader_id.0))
                .collect();
            self.topics.insert(
                name.clone(),
                Topic {
                    name,
                    internal: topic.is_internal,
                    leaders,
                },
            );
        }
        Ok(())
    }

    /// Every topic of the cluster, read again.
    pub async fn topics(&mut self) -> Result<Vec<Topic>> {
        self.topics.clear();
        self.refresh(None, false).await?;
        Ok(self.topics.values().cloned().collect())
    }

    /// A topic's partitions and leaders, read when not known yet.
    async fn topic(&mut self, name: &str, create: bool) -> Result<Topic> {
        if !self.topics.contains_key(name) {
            self.refresh(Some(&[name.to_string()]), create).await?;
        }
        self.topics
            .get(name)
            .cloned()
            .filter(|topic| !topic.leaders.is_empty())
            .ok_or_else(|| invalid(format!("Topic {name} has no partitions")))
    }

    /// The connection to a broker, opened through the egress policy when needed.
    async fn broker(&mut self, id: i32) -> Result<&mut Connection> {
        if !self.connections.contains_key(&id) {
            let (host, port) = self
                .brokers
                .get(&id)
                .cloned()
                .ok_or_else(|| invalid(format!("The cluster did not describe broker {id}")))?;
            let connection = Connection::open(&self.settings, &host, port).await?;
            self.connections.insert(id, connection);
        }
        Ok(self.connections.get_mut(&id).expect("just inserted"))
    }
    /// Forgets a broker's connection after a failure, and the leaders the metadata gave.
    fn forget(&mut self, id: i32, topic: &str) {
        self.connections.remove(&id);
        self.topics.remove(topic);
    }

    /// Produces a message and returns where it was written.
    pub async fn produce(&mut self, message: Outgoing) -> Result<Value> {
        for attempt in 0..2 {
            let topic = self.topic(&message.topic, true).await?;
            let partition = match message.partition {
                Some(partition) if topic.leaders.contains_key(&partition) => partition,
                Some(partition) => {
                    return Err(invalid(format!(
                        "Topic {} has no partition {partition}",
                        topic.name
                    )));
                }
                None => self.partition_for(&topic, message.key.as_deref()),
            };
            let leader = topic.leaders[&partition];
            let request = produce_request(&message, partition)?;
            let answer = match self
                .broker(leader)
                .await?
                .call(&request, PRODUCE_VERSION)
                .await
            {
                Ok(answer) => answer,
                Err(error) => {
                    self.forget(leader, &topic.name);
                    if attempt == 0 {
                        continue;
                    }
                    return Err(error);
                }
            };
            let result = answer
                .responses
                .iter()
                .flat_map(|topic| topic.partition_responses.iter())
                .find(|response| response.index == partition)
                .ok_or_else(|| invalid("The broker did not answer for the partition"))?;
            if STALE_LEADER.contains(&result.error_code) && attempt == 0 {
                self.forget(leader, &topic.name);
                continue;
            }
            if result.error_code != 0 {
                return Err(error_of(
                    result.error_code,
                    result.error_message.as_ref().map(|m| m.to_string()),
                ));
            }
            return Ok(json!({
                "topic": topic.name,
                "partition": partition,
                "offset": result.base_offset,
            }));
        }
        Err(invalid("The partition leader kept changing"))
    }
    /// Java's default partitioner: the murmur2 hash of the key, or each partition in turn.
    fn partition_for(&mut self, topic: &Topic, key: Option<&[u8]>) -> i32 {
        let partitions: Vec<i32> = topic.leaders.keys().copied().collect();
        let index = match key {
            Some(key) => (murmur2(key) & 0x7fff_ffff) as usize % partitions.len(),
            None => {
                self.next_partition = self.next_partition.wrapping_add(1);
                self.next_partition % partitions.len()
            }
        };
        partitions[index]
    }

    /// Where reading starts in each partition of a topic (or only the one given).
    pub async fn positions(
        &mut self,
        name: &str,
        partition: Option<i32>,
        start: Start,
    ) -> Result<BTreeMap<i32, i64>> {
        let topic = self.topic(name, false).await?;
        let partitions: Vec<i32> = match partition {
            Some(partition) if topic.leaders.contains_key(&partition) => vec![partition],
            Some(partition) => {
                return Err(invalid(format!(
                    "Topic {name} has no partition {partition}"
                )));
            }
            None => topic.leaders.keys().copied().collect(),
        };
        let timestamp = match start {
            Start::Offset(offset) => {
                return Ok(partitions.into_iter().map(|p| (p, offset)).collect());
            }
            Start::Earliest => -2,
            Start::Latest => -1,
        };
        let mut positions = BTreeMap::new();
        for (leader, partitions) in by_leader(&topic, &partitions) {
            let mut request = ListOffsetsRequest::default();
            request.replica_id = BrokerId(-1);
            let mut wanted = ListOffsetsTopic::default();
            wanted.name = TopicName(StrBytes::from_string(name.to_string()));
            wanted.partitions = partitions
                .iter()
                .map(|partition| {
                    let mut wanted = ListOffsetsPartition::default();
                    wanted.partition_index = *partition;
                    wanted.current_leader_epoch = -1;
                    wanted.timestamp = timestamp;
                    wanted
                })
                .collect();
            request.topics = vec![wanted];
            let answer = self
                .broker(leader)
                .await?
                .call(&request, LIST_OFFSETS_VERSION)
                .await?;
            for partition in answer
                .topics
                .iter()
                .flat_map(|topic| topic.partitions.iter())
            {
                if partition.error_code != 0 {
                    return Err(error_of(partition.error_code, None));
                }
                positions.insert(partition.partition_index, partition.offset);
            }
        }
        Ok(positions)
    }

    /// The messages after each position, which move past them. Waits briefly for new ones.
    pub async fn fetch(
        &mut self,
        name: &str,
        positions: &mut BTreeMap<i32, i64>,
    ) -> Result<Vec<Value>> {
        let topic = self.topic(name, false).await?;
        let partitions: Vec<i32> = positions.keys().copied().collect();
        let mut messages = Vec::new();
        for (leader, partitions) in by_leader(&topic, &partitions) {
            let mut request = FetchRequest::default();
            request.replica_id = BrokerId(-1);
            request.max_wait_ms = FETCH_WAIT_MS;
            request.min_bytes = 1;
            request.max_bytes = FETCH_BYTES;
            request.session_epoch = -1;
            let mut wanted = FetchTopic::default();
            wanted.topic = TopicName(StrBytes::from_string(name.to_string()));
            wanted.partitions = partitions
                .iter()
                .map(|partition| {
                    let mut wanted = FetchPartition::default();
                    wanted.partition = *partition;
                    wanted.current_leader_epoch = -1;
                    wanted.fetch_offset = positions[partition];
                    wanted.log_start_offset = -1;
                    wanted.partition_max_bytes = PARTITION_BYTES;
                    wanted
                })
                .collect();
            request.topics = vec![wanted];
            let answer = match self
                .broker(leader)
                .await?
                .call(&request, FETCH_VERSION)
                .await
            {
                Ok(answer) => answer,
                Err(error) => {
                    self.forget(leader, name);
                    return Err(error);
                }
            };
            if answer.error_code != 0 {
                return Err(error_of(answer.error_code, None));
            }
            for partition in answer
                .responses
                .iter()
                .flat_map(|topic| topic.partitions.iter())
            {
                if STALE_LEADER.contains(&partition.error_code) {
                    self.forget(leader, name);
                    continue;
                }
                if partition.error_code != 0 {
                    return Err(error_of(
                        partition.error_code,
                        Some(format!("partition {}", partition.partition_index)),
                    ));
                }
                let Some(position) = positions.get_mut(&partition.partition_index) else {
                    continue;
                };
                for record in decode(partition.records.clone())? {
                    // A batch may start before the position asked for.
                    if record.offset < *position || record.control {
                        continue;
                    }
                    *position = record.offset + 1;
                    if messages.len() < MAX_MESSAGES {
                        messages.push(consumed(name, partition.partition_index, &record));
                    }
                }
            }
        }
        Ok(messages)
    }
}

/// The partitions grouped by the broker that leads them.
fn by_leader(topic: &Topic, partitions: &[i32]) -> BTreeMap<i32, Vec<i32>> {
    let mut grouped: BTreeMap<i32, Vec<i32>> = BTreeMap::new();
    for partition in partitions {
        if let Some(leader) = topic.leaders.get(partition) {
            grouped.entry(*leader).or_default().push(*partition);
        }
    }
    grouped
}

fn produce_request(message: &Outgoing, partition: i32) -> Result<ProduceRequest> {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0);
    let record = Record {
        transactional: false,
        control: false,
        delete_horizon: false,
        partition_leader_epoch: -1,
        producer_id: -1,
        producer_epoch: -1,
        timestamp_type: TimestampType::Creation,
        offset: 0,
        sequence: -1,
        timestamp,
        key: message.key.clone(),
        value: message.value.clone(),
        headers: message
            .headers
            .iter()
            .map(|(name, value)| (StrBytes::from_string(name.clone()), Some(value.clone())))
            .collect::<IndexMap<_, _>>(),
    };
    let mut batch = BytesMut::new();
    RecordBatchEncoder::encode(
        &mut batch,
        [&record],
        &RecordEncodeOptions {
            version: 2,
            compression: Compression::None,
        },
    )
    .map_err(|error| invalid(format!("Cannot encode the message: {error}")))?;
    let mut data = PartitionProduceData::default();
    data.index = partition;
    data.records = Some(batch.freeze());
    let mut topic = TopicProduceData::default();
    topic.name = TopicName(StrBytes::from_string(message.topic.clone()));
    topic.partition_data = vec![data];
    let mut request = ProduceRequest::default();
    // Acknowledged by every in-sync replica, as the Java producer does by default.
    request.acks = -1;
    request.timeout_ms = 15_000;
    request.topic_data = vec![topic];
    Ok(request)
}

/// The records of a fetched partition. The last batch may be cut at the size limit: it is
/// left for the next fetch.
fn decode(records: Option<Bytes>) -> Result<Vec<Record>> {
    let Some(mut buffer) = records else {
        return Ok(Vec::new());
    };
    let mut decoded = Vec::new();
    while !buffer.is_empty() {
        match RecordBatchDecoder::decode_with_custom_compression(&mut buffer, Some(decompress)) {
            Ok(set) => decoded.extend(set.records),
            Err(error) if decoded.is_empty() && buffer.len() > 61 => {
                return Err(invalid(format!("Cannot read the messages: {error}")));
            }
            Err(_) => break,
        }
    }
    Ok(decoded)
}

/// Decompresses a batch: none, gzip and snappy with the codec's own code, lz4 and zstd with
/// pure-Rust decoders, so no C compression library is built.
fn decompress(buffer: &mut Bytes, compression: Compression) -> anyhow::Result<Bytes> {
    use bytes::Buf;
    use kafka_protocol::compression::{Decompressor, Gzip, None as Plain, Snappy};
    let all = |buffer: &mut Bytes| Ok(buffer.copy_to_bytes(buffer.remaining()));
    let read = |reader: &mut dyn Read| -> anyhow::Result<Bytes> {
        let mut output = Vec::new();
        reader.take(MAX_DECOMPRESSED).read_to_end(&mut output)?;
        Ok(Bytes::from(output))
    };
    match compression {
        Compression::None => Plain::decompress(buffer, all),
        Compression::Gzip => Gzip::decompress(buffer, all),
        Compression::Snappy => Snappy::decompress(buffer, all),
        Compression::Lz4 => read(&mut lz4_flex::frame::FrameDecoder::new(buffer.as_ref())),
        Compression::Zstd => read(&mut ruzstd::decoding::StreamingDecoder::new(
            buffer.as_ref(),
        )?),
    }
}

/// Bytes as text when they are UTF-8, otherwise `{"$binary": base64}`.
fn shown(bytes: &Option<Bytes>) -> Value {
    match bytes {
        None => Value::Null,
        Some(bytes) => match std::str::from_utf8(bytes) {
            Ok(text) => Value::String(text.to_string()),
            Err(_) => json!({"$binary": STANDARD.encode(bytes)}),
        },
    }
}
/// Text as bytes; `{"$binary": base64}` as the bytes it holds.
pub fn bytes_of(text: &str) -> Result<Bytes> {
    if let Ok(Value::Object(object)) = serde_json::from_str::<Value>(text.trim())
        && object.len() == 1
        && let Some(encoded) = object.get("$binary").and_then(Value::as_str)
    {
        return STANDARD
            .decode(encoded)
            .map(Bytes::from)
            .map_err(|_| invalid("A $binary value must be base64"));
    }
    Ok(Bytes::from(text.to_string()))
}

fn consumed(topic: &str, partition: i32, record: &Record) -> Value {
    let headers: Map<String, Value> = record
        .headers
        .iter()
        .map(|(name, value)| (name.to_string(), shown(value)))
        .collect();
    json!({
        "topic": topic,
        "partition": partition,
        "offset": record.offset,
        "timestamp": record.timestamp,
        "key": shown(&record.key),
        "value": shown(&record.value),
        "headers": headers,
    })
}

/// Kafka's murmur2, as the Java client hashes keys to choose a partition.
pub fn murmur2(data: &[u8]) -> i32 {
    const SEED: u32 = 0x9747_b28c;
    const M: u32 = 0x5bd1_e995;
    let length = data.len();
    let mut h = SEED ^ length as u32;
    let (chunks, rest) = data.as_chunks::<4>();
    for chunk in chunks {
        let mut k = u32::from_le_bytes(*chunk);
        k = k.wrapping_mul(M);
        k ^= k >> 24;
        k = k.wrapping_mul(M);
        h = h.wrapping_mul(M);
        h ^= k;
    }
    if rest.len() >= 3 {
        h ^= (rest[2] as u32) << 16;
    }
    if rest.len() >= 2 {
        h ^= (rest[1] as u32) << 8;
    }
    if !rest.is_empty() {
        h ^= rest[0] as u32;
        h = h.wrapping_mul(M);
    }
    h ^= h >> 13;
    h = h.wrapping_mul(M);
    h ^= h >> 15;
    h as i32
}

#[cfg(test)]
pub(crate) mod tests;
