//! WebSocket, Socket.IO, MQTT, Kafka and GraphQL subscription connections whose events clients
//! read by polling.

mod engineio;
mod events;
mod graphql;
mod kafka;
mod mqtt_client;
mod sessions;
mod settings;
mod socketio;
mod websocket;

use crate::mqtt;
use crate::{egress::Policy, tls::client_config};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use engineio::{Polling, SocketIoLink, socketio_url};
use events::{Events, Log};
use futures_util::{SinkExt, StreamExt};
use kafka::{KafkaCommand, kafka_command, kafka_session};
use mqtt_client::qos;
use nexo_domain::{Error, Result};
use rumqttc::{
    ConnectReturnCode, Packet, PubAck, PubComp, PubRec, PubRel, Publish, QoS, Subscribe,
    SubscribeReasonCode, Unsubscribe, mqttbytes::v4::Connect,
};
use serde_json::{Value, json};
use settings::{header_rows, with_credentials};
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::mpsc;
use tokio_tungstenite::{
    Connector, client_async_tls_with_config,
    tungstenite::{
        Message,
        client::IntoClientRequest,
        http::{HeaderName, HeaderValue},
        protocol::WebSocketConfig,
    },
};
use tokio_util::sync::CancellationToken;
use url::Url;

const MAX_OPEN_SESSIONS: usize = 16;
const MAX_EVENTS: usize = 1000;
const CLOSED_SESSION_TTL: Duration = Duration::from_secs(5 * 60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_MESSAGE: usize = 8 * 1024 * 1024;
/// How long a GraphQL server has to acknowledge `connection_init`, as `graphql-ws` waits.
const ACK_TIMEOUT: Duration = Duration::from_secs(10);

fn invalid(message: impl Into<String>) -> Error {
    Error::Validation(message.into())
}

enum Command {
    Text(String),
    Publish {
        topic: String,
        message: String,
        qos: QoS,
        retain: bool,
    },
    Subscribe {
        topic: String,
        qos: QoS,
    },
    Unsubscribe(String),
    Emit {
        event: String,
        value: Value,
    },
    Kafka(KafkaCommand),
}

struct Session {
    protocol: String,
    url: String,
    events: Events,
    commands: mpsc::UnboundedSender<Command>,
    stop: CancellationToken,
}

pub struct Realtime {
    sessions: Mutex<HashMap<String, Session>>,
    egress: Policy,
    loopback_ports: Arc<dyn Fn() -> Vec<u16> + Send + Sync>,
}
impl Realtime {
    pub fn new(egress: Policy, loopback_ports: Arc<dyn Fn() -> Vec<u16> + Send + Sync>) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            egress,
            loopback_ports,
        }
    }
    fn sweep(&self) {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions.retain(|_, session| session.events.open() || !session.events.expired());
    }
    pub async fn connect(&self, payload: &Value) -> Result<Value> {
        self.sweep();
        let open = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|s| s.events.open())
            .count();
        if open >= MAX_OPEN_SESSIONS {
            return Err(invalid(
                "Connection limit reached; close a connection first",
            ));
        }
        let protocol = payload["protocol"].as_str().unwrap_or("");
        if protocol == "kafka" {
            return self.connect_kafka(payload);
        }
        // Vault references in the credentials (MQTT), only towards the hosts they allow.
        let payload = &with_credentials(payload)?;
        let allowed: &[&str] = match protocol {
            "websocket" => &["ws", "wss"],
            "mqtt" => &["mqtt", "mqtts", "ws", "wss"],
            "socketio" => &["http", "https"],
            // GraphQL endpoints are often written with http(s): they are reached over ws(s).
            "graphql-subscription" => &["ws", "wss", "http", "https"],
            _ => {
                return Err(invalid(
                    "Select WebSocket, Socket.IO, MQTT, Kafka or GraphQL subscription",
                ));
            }
        };
        if protocol == "graphql-subscription" {
            // Checked before connecting, so a mistake is answered at once.
            let name = payload["graphqlProtocol"].as_str();
            if !crate::graphql_sse::is_sse(name) {
                crate::graphql_ws::Protocol::from_name(name)?;
            }
            crate::graphql_ws::Operation::from_payload(payload)?;
        }
        let text = payload["url"].as_str().unwrap_or("");
        let url = Url::parse(text).map_err(|_| invalid("A complete URL is required"))?;
        if !allowed.contains(&url.scheme()) {
            return Err(invalid(format!(
                "Unsupported URL protocol {}:",
                url.scheme()
            )));
        }
        let host = url
            .host_str()
            .ok_or_else(|| invalid("A complete URL is required"))?
            .to_string();
        let port = url.port_or_known_default().unwrap_or(match url.scheme() {
            "mqtts" => 8883,
            _ => 1883,
        });
        let ports = (self.loopback_ports)();
        let addresses = self.egress.resolve(&host, port, &ports).await?;
        let id = uuid::Uuid::new_v4().to_string();
        let events = Events(Arc::new(Mutex::new(Log {
            state: "connecting".into(),
            ..Default::default()
        })));
        let (commands, receiver) = mpsc::unbounded_channel();
        let stop = CancellationToken::new();
        let tls = if matches!(url.scheme(), "wss" | "https" | "mqtts") {
            Some(client_config(payload)?)
        } else {
            None
        };
        let task = Task {
            payload: payload.clone(),
            url,
            events: events.clone(),
            commands: receiver,
            stop: stop.clone(),
            tls,
            addresses,
            id: id.clone(),
            egress: self.egress.clone(),
            loopback_ports: ports,
        };
        match protocol {
            "websocket" => tokio::spawn(task.websocket()),
            "socketio" => tokio::spawn(task.socketio()),
            "graphql-subscription" => tokio::spawn(task.graphql()),
            _ => tokio::spawn(task.mqtt()),
        };
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                id.clone(),
                Session {
                    protocol: protocol.into(),
                    url: text.into(),
                    events,
                    commands,
                    stop,
                },
            );
        Ok(json!({"id": id, "state": "connecting"}))
    }
    /// A Kafka connection: the settings are checked at once, the cluster is reached in the
    /// background like the other protocols.
    fn connect_kafka(&self, payload: &Value) -> Result<Value> {
        let settings = crate::kafka::Settings::from_payload(
            payload,
            self.egress.clone(),
            (self.loopback_ports)(),
        )?;
        let id = uuid::Uuid::new_v4().to_string();
        let events = Events(Arc::new(Mutex::new(Log {
            state: "connecting".into(),
            ..Default::default()
        })));
        let (commands, receiver) = mpsc::unbounded_channel();
        let stop = CancellationToken::new();
        tokio::spawn(kafka_session(
            settings,
            events.clone(),
            receiver,
            stop.clone(),
        ));
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                id.clone(),
                Session {
                    protocol: "kafka".into(),
                    url: payload["url"].as_str().unwrap_or_default().into(),
                    events,
                    commands,
                    stop,
                },
            );
        Ok(json!({"id": id, "state": "connecting"}))
    }
}

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct Task {
    payload: Value,
    url: Url,
    events: Events,
    commands: mpsc::UnboundedReceiver<Command>,
    stop: CancellationToken,
    tls: Option<Arc<rustls::ClientConfig>>,
    addresses: Vec<std::net::SocketAddr>,
    id: String,
    /// For HTTP long polling, which checks every request against the policy itself.
    egress: Policy,
    loopback_ports: Vec<u16>,
}

#[cfg(test)]
#[allow(clippy::result_large_err)]
mod tests;
