//! A Kafka client for the protocols panel: topics and partitions, producing messages with key,
//! headers and partition, and reading a topic from its start, its end or an offset.
//!
//! Only the wire codec comes from `kafka-protocol`. Connections are this crate's: every broker,
//! the bootstrap ones and those the cluster metadata announces, is checked against the egress
//! policy before connecting, TLS uses aws-lc-rs like every other protocol, and SASL (PLAIN,
//! SCRAM-SHA-256/512) uses the password from the vault, restricted to its allowed hosts.
//! Consumer groups and Schema Registry are not part of it.

mod cluster;
mod fetch;
mod produce;
pub use cluster::Cluster;
use cluster::by_leader;
pub use fetch::bytes_of;
#[cfg(test)]
use fetch::{decompress, shown};
pub use produce::murmur2;

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

#[cfg(test)]
pub(crate) mod tests;
