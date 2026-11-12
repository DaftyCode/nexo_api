//! The client against a broker that speaks the Kafka protocol through the same codec, and the
//! pieces that need no network.

mod broker;
mod connection;
mod records;

use super::*;
pub(crate) use broker::{Broker, start};
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
