//! WebSocket, Socket.IO, MQTT, Kafka and GraphQL subscription connections whose events clients
//! read by polling.
use crate::mqtt;
use crate::{egress::Policy, tls::client_config};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::{SinkExt, StreamExt};
use nexo_domain::{Error, Result};
use rumqttc::{
    ConnectReturnCode, Packet, PubAck, PubComp, PubRec, PubRel, Publish, QoS, Subscribe,
    SubscribeReasonCode, Unsubscribe, mqttbytes::v4::Connect,
};
use serde_json::{Value, json};
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
fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
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

enum KafkaCommand {
    Produce(crate::kafka::Outgoing),
    Subscribe {
        topic: String,
        partition: Option<i32>,
        start: crate::kafka::Start,
    },
    Unsubscribe,
    Topics,
}

#[derive(Default)]
struct Log {
    state: String,
    events: VecDeque<Value>,
    sequence: u64,
    closed_at: Option<Instant>,
}
/// Event log of one connection, shared with the task that runs it.
#[derive(Clone)]
struct Events(Arc<Mutex<Log>>);
impl Events {
    fn emit(&self, kind: &str, data: Value) {
        let mut log = self.0.lock().unwrap_or_else(|e| e.into_inner());
        log.sequence += 1;
        let sequence = log.sequence;
        log.events.push_back(
            json!({"sequence": sequence, "type": kind, "data": data, "time": now_millis()}),
        );
        while log.events.len() > MAX_EVENTS {
            log.events.pop_front();
        }
    }
    fn set(&self, state: &str) {
        let mut log = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if state == "closed" || state == "error" {
            log.closed_at.get_or_insert_with(Instant::now);
            if log.state == "error" && state == "closed" {
                return;
            }
        }
        log.state = state.to_string();
    }
    fn state(&self) -> String {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .state
            .clone()
    }
    fn open(&self) -> bool {
        matches!(self.state().as_str(), "connecting" | "connected")
    }
    fn expired(&self) -> bool {
        let log = self.0.lock().unwrap_or_else(|e| e.into_inner());
        log.closed_at
            .is_some_and(|closed| closed.elapsed() > CLOSED_SESSION_TTL)
    }
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
    pub fn send(&self, payload: &Value) -> Result<Value> {
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let session = sessions
            .get(payload["id"].as_str().unwrap_or_default())
            .ok_or_else(|| invalid("Connection not found"))?;
        if session.events.state() != "connected" {
            return Err(invalid("Connection is not open"));
        }
        let message = match &payload["message"] {
            Value::String(text) => text.clone(),
            Value::Null => String::new(),
            other => other.to_string(),
        };
        let qos = qos(&payload["qos"]);
        let command = match session.protocol.as_str() {
            "websocket" => Command::Text(message),
            "kafka" => Command::Kafka(kafka_command(payload, &message)?),
            "graphql-subscription" => {
                return Err(invalid(
                    "A subscription only receives; change the query and connect again",
                ));
            }
            "mqtt" => {
                let topic = payload["topic"]
                    .as_str()
                    .filter(|t| !t.is_empty())
                    .ok_or_else(|| invalid("Enter an MQTT topic"))?
                    .to_string();
                match payload["action"].as_str() {
                    Some("subscribe") => Command::Subscribe { topic, qos },
                    Some("unsubscribe") => Command::Unsubscribe(topic),
                    _ => Command::Publish {
                        topic,
                        message,
                        qos,
                        retain: payload["retain"] == true,
                    },
                }
            }
            _ => Command::Emit {
                event: payload["event"]
                    .as_str()
                    .filter(|e| !e.is_empty())
                    .unwrap_or("message")
                    .to_string(),
                value: serde_json::from_str(&message).unwrap_or(Value::String(message)),
            },
        };
        session
            .commands
            .send(command)
            .map_err(|_| invalid("Connection is not open"))?;
        Ok(json!({"sent": true}))
    }
    pub fn poll(&self, payload: &Value) -> Result<Value> {
        let id = payload["id"].as_str().unwrap_or_default();
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let session = sessions
            .get(id)
            .ok_or_else(|| invalid("Connection not found"))?;
        let after = payload["after"].as_u64().unwrap_or(0);
        let log = session.events.0.lock().unwrap_or_else(|e| e.into_inner());
        let events: Vec<Value> = log
            .events
            .iter()
            .filter(|event| event["sequence"].as_u64().unwrap_or(0) > after)
            .cloned()
            .collect();
        Ok(json!({"id": id, "state": log.state, "events": events}))
    }
    pub fn list(&self) -> Value {
        self.sweep();
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        Value::Array(
            sessions
                .iter()
                .map(|(id, s)| json!({"id": id, "protocol": s.protocol, "url": s.url, "state": s.events.state()}))
                .collect(),
        )
    }
    pub fn disconnect(&self, payload: &Value) -> Result<Value> {
        let session = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(payload["id"].as_str().unwrap_or_default())
            .ok_or_else(|| invalid("Connection not found"))?;
        session.stop.cancel();
        Ok(json!({"closed": true}))
    }
    pub fn close(&self) {
        for (_, session) in self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
        {
            session.stop.cancel();
        }
    }
}
/// The Engine.IO endpoint of a Socket.IO URL: its `path` (`/socket.io/` by default) with
/// `EIO=4`, without the namespace, which travels in the packets.
fn socketio_url(url: &Url, payload: &Value) -> Url {
    let mut base = url.clone();
    let path = payload["path"]
        .as_str()
        .filter(|p| !p.is_empty())
        .unwrap_or("/socket.io");
    base.set_path(&format!("{}/", path.trim_end_matches('/')));
    base.set_query(None);
    base.query_pairs_mut().append_pair("EIO", "4");
    base
}

/// An Engine.IO long-polling session: a GET waits for packets, a POST sends them. Each request
/// carries the connection's headers and the session cookies, as sticky sessions need.
struct Polling {
    transport: Arc<crate::transport::Transport>,
    url: Url,
    sid: String,
    upgrades: Vec<String>,
    headers: Vec<(String, String)>,
    jar: crate::transport::CookieJar,
    /// Packets that came with the handshake.
    buffered: Vec<crate::socketio::Frame>,
}
impl Polling {
    async fn open(task: &Task, base: &Url) -> Result<Self> {
        let jar: crate::transport::CookieJar = Arc::default();
        let options = crate::transport::Options {
            strict_ssl: task.payload["strictSSL"] != false,
            follow_redirects: false,
            // A long poll is held until the server has packets or pings, every 25 s by default.
            timeout: Duration::from_secs(60),
            trust_redirect_credentials: false,
            transport: json!({"caPem": task.payload["caPem"]}),
            egress: task.egress.clone(),
            loopback_ports: task.loopback_ports.clone(),
        };
        let transport = Arc::new(crate::transport::Transport::new(options, jar.clone())?);
        let mut url = base.clone();
        url.query_pairs_mut().append_pair("transport", "polling");
        let mut polling = Self {
            transport,
            url,
            sid: String::new(),
            upgrades: Vec::new(),
            headers: header_rows(&task.payload["headers"]),
            jar,
            buffered: Vec::new(),
        };
        let mut frames = polling.get().await?.into_iter();
        let open = match frames.next() {
            Some(crate::socketio::Frame::Text(text)) => crate::socketio::handshake(&text),
            _ => None,
        }
        .ok_or_else(|| invalid("The server did not open a long-polling session"))?;
        polling.sid = open.sid;
        polling.upgrades = open.upgrades;
        polling.buffered = frames.collect();
        Ok(polling)
    }
    fn address(&self) -> String {
        let mut url = self.url.clone();
        if !self.sid.is_empty() {
            url.query_pairs_mut().append_pair("sid", &self.sid);
        }
        // As the official client does, so no cache answers a poll.
        url.query_pairs_mut()
            .append_pair("t", &uuid::Uuid::new_v4().simple().to_string()[..8]);
        url.to_string()
    }
    fn header(&self, extra: &[(&str, &str)]) -> Value {
        Value::Array(
            self.headers
                .iter()
                .map(|(key, value)| json!({"key": key, "value": value}))
                .chain(
                    extra
                        .iter()
                        .map(|(key, value)| json!({"key": key, "value": value})),
                )
                .collect(),
        )
    }
    async fn get(&self) -> Result<Vec<crate::socketio::Frame>> {
        let answer = self
            .transport
            .request(
                &json!({"method": "GET", "url": self.address(), "header": self.header(&[])}),
                &[],
            )
            .await?;
        Ok(crate::socketio::decode_payload(&Self::body(&answer)?))
    }
    async fn post(&self, frames: &[crate::socketio::Frame]) -> Result<()> {
        let body = crate::socketio::encode_payload(frames);
        let answer = self
            .transport
            .request(
                &json!({
                    "method": "POST",
                    "url": self.address(),
                    "header": self.header(&[("Content-Type", "text/plain;charset=UTF-8")]),
                    "body": {"mode": "raw", "raw": body},
                }),
                &[],
            )
            .await?;
        Self::body(&answer).map(|_| ())
    }
    fn body(answer: &Value) -> Result<String> {
        let status = answer["status"].as_u64().unwrap_or(0);
        let body = answer["body"].as_str().unwrap_or_default().to_string();
        if (200..300).contains(&status) {
            Ok(body)
        } else {
            Err(invalid(format!(
                "Long polling failed (HTTP {status}): {body}"
            )))
        }
    }
    /// The session cookies for a URL, as a `Cookie` header.
    fn cookie(&self, url: &Url) -> Option<String> {
        let jar = self.jar.lock().unwrap_or_else(|e| e.into_inner());
        let cookie = jar
            .get_request_values(url)
            .map(|(name, value)| format!("{name}={value}"))
            .collect::<Vec<_>>()
            .join("; ");
        (!cookie.is_empty()).then_some(cookie)
    }
    /// Polls in the background, one request at a time, until the session ends.
    fn start(self) -> PollingLink {
        let session = Arc::new(self);
        let (sender, receiver) = mpsc::channel(16);
        let poller = session.clone();
        let task = tokio::spawn(async move {
            loop {
                let polled = poller.get().await;
                let closed = polled.as_ref().map_or(true, |frames| {
                    frames
                        .iter()
                        .any(|frame| frame == &crate::socketio::Frame::Text("1".into()))
                });
                if sender.send(polled).await.is_err() || closed {
                    return;
                }
            }
        });
        let pending = session.buffered.clone().into();
        PollingLink {
            session,
            receiver,
            task,
            pending,
        }
    }
}

/// A long-polling session whose answers arrive from a background poll.
struct PollingLink {
    session: Arc<Polling>,
    receiver: mpsc::Receiver<Result<Vec<crate::socketio::Frame>>>,
    task: tokio::task::JoinHandle<()>,
    pending: VecDeque<crate::socketio::Frame>,
}
impl Drop for PollingLink {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// The transport a Socket.IO connection uses.
enum SocketIoLink {
    Socket(Box<Socket>),
    Polling(Box<PollingLink>),
}
impl SocketIoLink {
    fn name(&self) -> &'static str {
        match self {
            Self::Socket(_) => "websocket",
            Self::Polling(_) => "polling",
        }
    }
    async fn send(
        &mut self,
        frames: Vec<crate::socketio::Frame>,
    ) -> std::result::Result<(), String> {
        match self {
            Self::Socket(socket) => {
                for frame in frames {
                    let message = match frame {
                        crate::socketio::Frame::Text(text) => Message::text(text),
                        crate::socketio::Frame::Binary(bytes) => Message::binary(bytes),
                    };
                    socket
                        .send(message)
                        .await
                        .map_err(|error| error.to_string())?;
                }
                Ok(())
            }
            Self::Polling(link) => link
                .session
                .post(&frames)
                .await
                .map_err(|error| error.to_string()),
        }
    }
    async fn next(&mut self) -> Option<std::result::Result<crate::socketio::Frame, String>> {
        match self {
            Self::Socket(socket) => loop {
                return match socket.next().await? {
                    Ok(Message::Text(text)) => {
                        Some(Ok(crate::socketio::Frame::Text(text.to_string())))
                    }
                    Ok(Message::Binary(bytes)) => {
                        Some(Ok(crate::socketio::Frame::Binary(bytes.to_vec())))
                    }
                    Ok(Message::Close(_)) => None,
                    Ok(_) => continue,
                    Err(error) => Some(Err(error.to_string())),
                };
            },
            Self::Polling(link) => loop {
                if let Some(frame) = link.pending.pop_front() {
                    return Some(Ok(frame));
                }
                match link.receiver.recv().await? {
                    Ok(frames) => link.pending.extend(frames),
                    Err(error) => return Some(Err(error.to_string())),
                }
            },
        }
    }
    /// Leaves the namespace (when given) and ends the session.
    async fn close(&mut self, disconnect: &str) {
        let mut frames = Vec::new();
        if !disconnect.is_empty() {
            frames.push(crate::socketio::Frame::Text(disconnect.to_string()));
        }
        match self {
            Self::Socket(socket) => {
                for frame in frames {
                    if let crate::socketio::Frame::Text(text) = frame {
                        let _ = socket.send(Message::text(text)).await;
                    }
                }
                let _ = Socket::close(socket.as_mut(), None).await;
            }
            Self::Polling(link) => {
                frames.push(crate::socketio::Frame::Text("1".into()));
                let _ = link.session.post(&frames).await;
            }
        }
    }
}

/// Replaces vault references in `username` and `password` with the secrets the application
/// resolved, and fails when one may not go to the connection's host.
fn with_credentials(payload: &Value) -> Result<Value> {
    let referenced =
        nexo_application::vault_references(&json!([payload["username"], payload["password"]]));
    if referenced.is_empty() {
        return Ok(payload.clone());
    }
    let host = Url::parse(payload["url"].as_str().unwrap_or_default())
        .ok()
        .and_then(|url| url.host_str().map(String::from))
        .unwrap_or_default();
    for secret in crate::secret_hosts::restricted(payload) {
        if referenced.contains(&secret.name) && !secret.hosts.allows(&host) {
            return Err(crate::secret_hosts::denied(&secret.name, &host));
        }
    }
    let secrets: serde_json::Map<String, Value> = payload["resolvedSecrets"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(name, value)| (format!("vault:{name}"), value.clone()))
        .collect();
    let mut filled = payload.clone();
    for field in ["username", "password"] {
        if let Some(text) = payload[field].as_str() {
            filled[field] = json!(crate::scripts::fill(text, &secrets));
        }
    }
    Ok(filled)
}

/// A Kafka `realtime.send`: `produce` by default, or `subscribe`, `unsubscribe`, `topics`.
fn kafka_command(payload: &Value, message: &str) -> Result<KafkaCommand> {
    let topic = || {
        payload["topic"]
            .as_str()
            .map(str::trim)
            .filter(|topic| !topic.is_empty())
            .map(String::from)
            .ok_or_else(|| invalid("Enter a Kafka topic"))
    };
    let partition = payload["partition"]
        .as_i64()
        .map(|partition| i32::try_from(partition).map_err(|_| invalid("Enter a valid partition")))
        .transpose()?;
    Ok(match payload["action"].as_str().unwrap_or("produce") {
        "subscribe" => KafkaCommand::Subscribe {
            topic: topic()?,
            partition,
            start: crate::kafka::Start::from_payload(payload)?,
        },
        "unsubscribe" => KafkaCommand::Unsubscribe,
        "topics" => KafkaCommand::Topics,
        "produce" | "publish" => KafkaCommand::Produce(crate::kafka::Outgoing {
            topic: topic()?,
            partition,
            key: payload["key"]
                .as_str()
                .filter(|key| !key.is_empty())
                .map(crate::kafka::bytes_of)
                .transpose()?,
            value: Some(crate::kafka::bytes_of(message)?),
            headers: header_rows(&payload["headers"])
                .into_iter()
                .map(|(name, value)| Ok((name, crate::kafka::bytes_of(&value)?)))
                .collect::<Result<_>>()?,
        }),
        other => return Err(invalid(format!("Unknown Kafka action {other}"))),
    })
}

/// A Kafka connection: commands produce and choose what is read; while a topic is being read,
/// its new messages are fetched between commands.
async fn kafka_session(
    settings: crate::kafka::Settings,
    events: Events,
    mut commands: mpsc::UnboundedReceiver<Command>,
    stop: CancellationToken,
) {
    let fail = |message: String| {
        events.emit("error", json!(message));
        events.set("error");
    };
    let mut cluster = tokio::select! {
        _ = stop.cancelled() => return,
        connected = tokio::time::timeout(CONNECT_TIMEOUT * 2, crate::kafka::Cluster::connect(settings)) => match connected {
            Ok(Ok(cluster)) => cluster,
            Ok(Err(error)) => return fail(error.to_string()),
            Err(_) => return fail("Connecting to the cluster timed out".into()),
        },
    };
    events.set("connected");
    events.emit("open", json!("Connected"));
    let topics = |topics: Vec<crate::kafka::Topic>| {
        json!(topics
            .into_iter()
            .map(|topic| json!({"name": topic.name, "partitions": topic.leaders.len(), "internal": topic.internal}))
            .collect::<Vec<_>>())
    };
    match cluster.topics().await {
        Ok(listed) => events.emit("topics", topics(listed)),
        Err(error) => events.emit("error", json!(error.to_string())),
    }
    let mut reading: Option<(String, BTreeMap<i32, i64>)> = None;
    loop {
        tokio::select! {
            biased;
            _ = stop.cancelled() => {
                events.set("closed");
                return;
            }
            command = commands.recv() => {
                let Some(Command::Kafka(command)) = command else {
                    if command.is_none() {
                        return;
                    }
                    continue;
                };
                match command {
                    KafkaCommand::Produce(message) => match cluster.produce(message).await {
                        Ok(written) => events.emit("produced", written),
                        Err(error) => events.emit("error", json!(error.to_string())),
                    },
                    KafkaCommand::Subscribe { topic, partition, start } => {
                        match cluster.positions(&topic, partition, start).await {
                            Ok(positions) => {
                                events.emit("subscribed", json!({"topic": topic, "positions": positions}));
                                reading = Some((topic, positions));
                            }
                            Err(error) => events.emit("error", json!(error.to_string())),
                        }
                    }
                    KafkaCommand::Unsubscribe => {
                        if let Some((topic, _)) = reading.take() {
                            events.emit("unsubscribed", json!({"topic": topic}));
                        }
                    }
                    KafkaCommand::Topics => match cluster.topics().await {
                        Ok(listed) => events.emit("topics", topics(listed)),
                        Err(error) => events.emit("error", json!(error.to_string())),
                    },
                }
            }
            // Waits up to half a second for new messages, then lets commands in again.
            _ = std::future::ready(()), if reading.is_some() => {
                let (topic, positions) = reading.as_mut().expect("reading");
                match cluster.fetch(topic, positions).await {
                    Ok(messages) => {
                        for message in messages {
                            events.emit("message", message);
                        }
                    }
                    Err(error) => {
                        events.emit("error", json!(error.to_string()));
                        reading = None;
                    }
                }
            }
        }
    }
}

fn qos(value: &Value) -> QoS {
    match value
        .as_u64()
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
    {
        Some(1) => QoS::AtLeastOnce,
        Some(2) => QoS::ExactlyOnce,
        _ => QoS::AtMostOnce,
    }
}
fn header_rows(value: &Value) -> Vec<(String, String)> {
    let text = |value: &Value| match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    };
    match value {
        Value::Array(rows) => rows
            .iter()
            .filter(|row| row["enabled"] != false)
            .filter_map(|row| {
                row["key"]
                    .as_str()
                    .filter(|k| !k.is_empty())
                    .map(|k| (k.to_string(), text(&row["value"])))
            })
            .collect(),
        Value::Object(map) => map.iter().map(|(k, v)| (k.clone(), text(v))).collect(),
        _ => Vec::new(),
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
impl Task {
    fn fail(&self, message: String) {
        self.events.emit("error", json!(message));
        self.events.set("error");
    }
    /// Opens a WebSocket to the address the egress policy approved.
    async fn open_socket(&self, url: &Url, protocols: &[String]) -> Result<Socket> {
        self.open_socket_with(url, protocols, &[]).await
    }
    /// Opens a WebSocket with headers besides the connection's own, such as a session cookie.
    async fn open_socket_with(
        &self,
        url: &Url,
        protocols: &[String],
        extra: &[(String, String)],
    ) -> Result<Socket> {
        let mut request = url
            .as_str()
            .into_client_request()
            .map_err(|error| invalid(error.to_string()))?;
        for (key, value) in header_rows(&self.payload["headers"])
            .into_iter()
            .chain(extra.iter().cloned())
        {
            let name = HeaderName::try_from(key.as_str())
                .map_err(|_| invalid(format!("Invalid header {key}")))?;
            let value = HeaderValue::try_from(value)
                .map_err(|_| invalid(format!("Invalid value for header {key}")))?;
            request.headers_mut().append(name, value);
        }
        if !protocols.is_empty() {
            let value = HeaderValue::try_from(protocols.join(", "))
                .map_err(|_| invalid("Invalid subprotocol"))?;
            request
                .headers_mut()
                .insert("sec-websocket-protocol", value);
        }
        let connect = async {
            let stream = tokio::net::TcpStream::connect(&self.addresses[..])
                .await
                .map_err(|error| invalid(error.to_string()))?;
            let config = WebSocketConfig::default()
                .max_message_size(Some(MAX_MESSAGE))
                .max_frame_size(Some(MAX_MESSAGE));
            let connector = self
                .tls
                .clone()
                .map(Connector::Rustls)
                .unwrap_or(Connector::Plain);
            client_async_tls_with_config(request, stream, Some(config), Some(connector))
                .await
                .map(|(socket, _)| socket)
                .map_err(|error| invalid(error.to_string()))
        };
        tokio::time::timeout(CONNECT_TIMEOUT, connect)
            .await
            .map_err(|_| invalid("Opening handshake has timed out"))?
    }

    async fn websocket(mut self) {
        let protocols: Vec<String> = self.payload["subprotocols"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(String::from)
            .collect();
        let url = self.url.clone();
        let mut socket = tokio::select! {
            _ = self.stop.cancelled() => return,
            opened = self.open_socket(&url, &protocols) => match opened {
                Ok(socket) => socket,
                Err(error) => return self.fail(error.to_string()),
            },
        };
        self.events.set("connected");
        self.events.emit("open", json!("Connected"));
        loop {
            tokio::select! {
                _ = self.stop.cancelled() => {
                    let _ = socket.close(None).await;
                    return;
                }
                command = self.commands.recv() => {
                    if let Some(Command::Text(text)) = command
                        && let Err(error) = socket.send(Message::text(text)).await
                    {
                        self.events.emit("error", json!(error.to_string()));
                    }
                }
                message = socket.next() => match message {
                    Some(Ok(Message::Text(text))) => self.events.emit("message", json!({"text": text.as_str(), "binary": false})),
                    Some(Ok(Message::Binary(data))) => self.events.emit("message", json!({"text": STANDARD.encode(&data), "binary": true})),
                    Some(Ok(Message::Close(frame))) => {
                        let (code, reason) = frame.map(|f| (u16::from(f.code), f.reason.to_string())).unwrap_or((1005, String::new()));
                        self.events.emit("close", json!({"code": code, "reason": reason}));
                        self.events.set("closed");
                        return;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(error)) => return self.fail(error.to_string()),
                    None => {
                        self.events.emit("close", json!({"code": 1006, "reason": ""}));
                        self.events.set("closed");
                        return;
                    }
                },
            }
        }
    }

    /// A GraphQL subscription over WebSocket, with `graphql-transport-ws` or the legacy
    /// `graphql-ws`. Each result is a `next` event; closing ends the subscription first.
    async fn graphql(mut self) {
        use crate::graphql_ws::{self, Incoming};
        if crate::graphql_sse::is_sse(self.payload["graphqlProtocol"].as_str()) {
            return match graphql_ws::Operation::from_payload(&self.payload) {
                Ok(operation) => self.graphql_sse(operation).await,
                Err(error) => self.fail(error.to_string()),
            };
        }
        let (protocol, operation) = match (
            graphql_ws::Protocol::from_name(self.payload["graphqlProtocol"].as_str()),
            graphql_ws::Operation::from_payload(&self.payload),
        ) {
            (Ok(protocol), Ok(operation)) => (protocol, operation),
            (Err(error), _) | (_, Err(error)) => return self.fail(error.to_string()),
        };
        let mut url = self.url.clone();
        match url.scheme() {
            "http" => {
                let _ = url.set_scheme("ws");
            }
            "https" => {
                let _ = url.set_scheme("wss");
            }
            _ => {}
        }
        let subprotocols = [protocol.subprotocol().to_string()];
        let mut socket = tokio::select! {
            _ = self.stop.cancelled() => return,
            opened = self.open_socket(&url, &subprotocols) => match opened {
                Ok(socket) => socket,
                Err(error) => return self.fail(error.to_string()),
            },
        };
        if let Err(error) = socket
            .send(Message::text(graphql_ws::init(&operation)))
            .await
        {
            return self.fail(error.to_string());
        }
        let acknowledged = tokio::time::sleep(ACK_TIMEOUT);
        tokio::pin!(acknowledged);
        let mut subscribed = false;
        loop {
            tokio::select! {
                _ = self.stop.cancelled() => {
                    if subscribed {
                        for message in graphql_ws::stop(protocol) {
                            let _ = socket.send(Message::text(message)).await;
                        }
                    }
                    let _ = socket.close(None).await;
                    return;
                }
                _ = &mut acknowledged, if !subscribed => {
                    let _ = socket.close(None).await;
                    return self.fail("The server did not acknowledge the connection".into());
                }
                // Nothing is sent from the panel: the subscription only receives.
                _ = self.commands.recv() => {}
                message = socket.next() => match message {
                    Some(Ok(Message::Text(text))) => match graphql_ws::parse(protocol, text.as_str()) {
                        Incoming::Ack if !subscribed => {
                            if let Err(error) = socket.send(Message::text(graphql_ws::subscribe(protocol, &operation))).await {
                                return self.fail(error.to_string());
                            }
                            subscribed = true;
                            self.events.set("connected");
                            self.events.emit("open", json!("Subscribed"));
                        }
                        Incoming::Ack | Incoming::Quiet => {}
                        Incoming::Next(payload) => self.events.emit("next", payload),
                        Incoming::Error(payload) => self.events.emit("error", payload),
                        Incoming::Ping(payload) => {
                            let _ = socket.send(Message::text(graphql_ws::pong(&payload))).await;
                        }
                        Incoming::Complete => {
                            self.events.emit("complete", json!("The server ended the subscription"));
                            let _ = socket.close(None).await;
                            self.events.set("closed");
                            return;
                        }
                        Incoming::Other(message) => self.events.emit("message", message),
                    },
                    Some(Ok(Message::Close(frame))) => {
                        let (code, reason) = frame.map(|f| (u16::from(f.code), f.reason.to_string())).unwrap_or((1005, String::new()));
                        self.events.emit("close", json!({"code": code, "reason": reason}));
                        self.events.set("closed");
                        return;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(error)) => return self.fail(error.to_string()),
                    None => {
                        self.events.emit("close", json!({"code": 1006, "reason": ""}));
                        self.events.set("closed");
                        return;
                    }
                },
            }
        }
    }

    /// A GraphQL subscription over server-sent events (`graphql-sse`, distinct connections):
    /// one POST whose response streams the results. Closing drops the connection, which ends
    /// the subscription. A server that answers with one JSON result instead gives just it.
    async fn graphql_sse(mut self, operation: crate::graphql_ws::Operation) {
        use crate::graphql_sse::{self, Incoming, Parser};
        let mut url = self.url.clone();
        match url.scheme() {
            "ws" => {
                let _ = url.set_scheme("http");
            }
            "wss" => {
                let _ = url.set_scheme("https");
            }
            _ => {}
        }
        let options = crate::transport::Options {
            strict_ssl: self.payload["strictSSL"] != false,
            follow_redirects: false,
            // A subscription stays open as long as it is wanted.
            timeout: Duration::from_secs(24 * 3600),
            trust_redirect_credentials: false,
            transport: json!({"caPem": self.payload["caPem"]}),
            egress: self.egress.clone(),
            loopback_ports: self.loopback_ports.clone(),
        };
        let transport = match crate::transport::Transport::new(options, Arc::default()) {
            Ok(transport) => transport,
            Err(error) => return self.fail(error.to_string()),
        };
        let headers = header_rows(&self.payload["headers"]);
        let mut response = tokio::select! {
            _ = self.stop.cancelled() => return,
            sent = transport.stream(&url, &headers, graphql_sse::body(&operation)) => match sent {
                Ok(response) => response,
                Err(error) => return self.fail(error.to_string()),
            },
        };
        let status = response.status();
        if !status.is_success() {
            let text = crate::transport::read_limited(response, 4096)
                .await
                .unwrap_or_default();
            return self.fail(format!("HTTP {}: {}", status.as_u16(), text.trim()));
        }
        let streamed = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("text/event-stream"));
        self.events.set("connected");
        self.events.emit("open", json!("Subscribed"));
        if !streamed {
            match crate::transport::read_limited(response, 4 * 1024 * 1024).await {
                Ok(text) => {
                    let result = serde_json::from_str(&text).unwrap_or(Value::String(text));
                    self.events.emit("next", result);
                    self.events
                        .emit("complete", json!("The server ended the subscription"));
                    self.events.set("closed");
                }
                Err(error) => self.fail(error.to_string()),
            }
            return;
        }
        let mut parser = Parser::default();
        loop {
            tokio::select! {
                // Dropping the response closes the connection, which ends the subscription.
                _ = self.stop.cancelled() => return,
                // Nothing is sent from the panel: the subscription only receives.
                _ = self.commands.recv() => {}
                chunk = response.chunk() => match chunk {
                    Ok(Some(bytes)) => {
                        for event in parser.push(&bytes) {
                            match graphql_sse::interpret(event) {
                                Incoming::Next(result) => self.events.emit("next", result),
                                Incoming::Complete => {
                                    self.events.emit("complete", json!("The server ended the subscription"));
                                    self.events.set("closed");
                                    return;
                                }
                                Incoming::Other(message) => self.events.emit("message", message),
                            }
                        }
                    }
                    Ok(None) => {
                        self.events.emit("close", json!({"code": 1000, "reason": "The server closed the stream"}));
                        self.events.set("closed");
                        return;
                    }
                    Err(error) => return self.fail(error.to_string()),
                },
            }
        }
    }

    /// Socket.IO v4 over Engine.IO v4. `transports` chooses how: `websocket`, `polling`
    /// (HTTP long polling, for networks whose proxies block WebSocket) or, by default, both as
    /// the official client does: long polling first, upgraded to WebSocket when the server
    /// offers it. Binary events arrive and are sent as `{"$binary": base64}`.
    async fn socketio(mut self) {
        use crate::socketio::{self, Frame};
        let namespace = match self.url.path() {
            "" | "/" => "/".to_string(),
            path => path.trim_end_matches('/').to_string(),
        };
        let mode = self.payload["transports"]
            .as_str()
            .unwrap_or("auto")
            .to_string();
        let opened = tokio::select! {
            _ = self.stop.cancelled() => return,
            opened = self.socketio_link(&mode) => opened,
        };
        let (mut link, handshaken) = match opened {
            Ok(opened) => opened,
            Err(error) => return self.fail(error.to_string()),
        };
        let connect = socketio::connect(&namespace, &self.payload["auth"]);
        if handshaken && let Err(error) = link.send(vec![Frame::Text(connect.clone())]).await {
            return self.fail(error);
        }
        let mut decoder = socketio::Decoder::default();
        let deadline = tokio::time::sleep(CONNECT_TIMEOUT);
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                _ = self.stop.cancelled() => {
                    link.close(&socketio::disconnect(&namespace)).await;
                    return;
                }
                _ = &mut deadline, if self.events.state() == "connecting" => {
                    link.close(&socketio::disconnect(&namespace)).await;
                    return self.fail("timeout".into());
                }
                command = self.commands.recv() => {
                    if let Some(Command::Emit { event, value }) = command {
                        match socketio::event(&namespace, &event, &value) {
                            Ok(frames) => if let Err(error) = link.send(frames).await {
                                self.events.emit("error", json!(error));
                            },
                            Err(error) => self.events.emit("error", json!(error)),
                        }
                    }
                }
                frame = link.next() => {
                    let text = match frame {
                        Some(Ok(Frame::Text(text))) => text,
                        Some(Ok(Frame::Binary(bytes))) => {
                            if let Some(packet) = decoder.binary(bytes) {
                                self.socketio_packet(packet, &namespace);
                            }
                            continue;
                        }
                        Some(Err(error)) => return self.fail(error),
                        None => {
                            if self.events.state() == "connecting" {
                                return self.fail("transport error".into());
                            }
                            self.events.emit("close", json!("transport close"));
                            self.events.set("closed");
                            return;
                        }
                    };
                    match text.as_bytes().first() {
                        // A WebSocket-only connection is opened by the server's handshake.
                        Some(b'0') => {
                            if let Err(error) = link.send(vec![Frame::Text(connect.clone())]).await {
                                return self.fail(error);
                            }
                        }
                        Some(b'2') => {
                            let _ = link.send(vec![Frame::Text("3".into())]).await;
                        }
                        Some(b'1') => {
                            self.events.emit("close", json!("transport close"));
                            self.events.set("closed");
                            return;
                        }
                        Some(b'4') => {
                            let Some(packet) = decoder.text(&text[1..]) else { continue };
                            if packet.namespace != namespace {
                                continue;
                            }
                            match packet.kind {
                                0 => {
                                    self.events.set("connected");
                                    self.events.emit("open", packet.data.get("sid").cloned().unwrap_or(json!(self.id)));
                                    self.events.emit("transport", json!(link.name()));
                                }
                                1 => {
                                    self.events.emit("close", json!("io server disconnect"));
                                    self.events.set("closed");
                                    link.close("").await;
                                    return;
                                }
                                4 => {
                                    link.close("").await;
                                    let message = packet.data["message"].as_str().map(String::from).unwrap_or_else(|| packet.data.to_string());
                                    return self.fail(message);
                                }
                                _ => self.socketio_packet(packet, &namespace),
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    /// Shows an event or an acknowledgement, binary data included.
    fn socketio_packet(&self, packet: crate::socketio::Packet, namespace: &str) {
        if packet.namespace != namespace {
            return;
        }
        match packet.kind {
            2 | 5 => {
                if let Some(items) = packet.data.as_array()
                    && let Some((event, rest)) = items.split_first()
                {
                    self.events
                        .emit("message", json!({"event": event, "data": rest}));
                }
            }
            3 | 6 => self
                .events
                .emit("ack", json!({"id": packet.id, "data": packet.data})),
            _ => {}
        }
    }

    /// Opens the Socket.IO connection with the transports chosen. Returns whether the
    /// Engine.IO handshake is already done (long polling) or still to come (WebSocket).
    async fn socketio_link(&self, mode: &str) -> Result<(SocketIoLink, bool)> {
        let base = socketio_url(&self.url, &self.payload);
        if mode == "websocket" {
            return Ok((
                SocketIoLink::Socket(Box::new(self.socketio_socket(&base, None).await?)),
                false,
            ));
        }
        let polling = match Polling::open(self, &base).await {
            Ok(polling) => polling,
            // A server that only accepts WebSocket refuses the long-polling handshake.
            Err(error) if mode == "polling" => return Err(error),
            Err(_) => {
                return Ok((
                    SocketIoLink::Socket(Box::new(self.socketio_socket(&base, None).await?)),
                    false,
                ));
            }
        };
        if mode == "auto"
            && polling
                .upgrades
                .iter()
                .any(|upgrade| upgrade == "websocket")
        {
            let upgraded = tokio::time::timeout(CONNECT_TIMEOUT, async {
                let mut socket = self.socketio_socket(&base, Some(&polling)).await?;
                socket
                    .send(Message::text("2probe"))
                    .await
                    .map_err(|error| invalid(error.to_string()))?;
                match socket.next().await {
                    Some(Ok(Message::Text(text))) if text.as_str() == "3probe" => {}
                    _ => return Err(invalid("The upgrade probe failed")),
                }
                socket
                    .send(Message::text("5"))
                    .await
                    .map_err(|error| invalid(error.to_string()))?;
                Ok(socket)
            })
            .await;
            // If the upgrade fails, the connection stays on long polling.
            if let Ok(Ok(socket)) = upgraded {
                self.events.emit("upgrade", json!("websocket"));
                return Ok((SocketIoLink::Socket(Box::new(socket)), true));
            }
        }
        Ok((SocketIoLink::Polling(Box::new(polling.start())), true))
    }

    /// A WebSocket to the Socket.IO endpoint; for an upgrade, of the long-polling session and
    /// with its cookies (sticky sessions).
    async fn socketio_socket(&self, base: &Url, session: Option<&Polling>) -> Result<Socket> {
        let mut url = base.clone();
        let _ = url.set_scheme(if url.scheme() == "https" { "wss" } else { "ws" });
        url.query_pairs_mut().append_pair("transport", "websocket");
        let mut extra = Vec::new();
        if let Some(session) = session {
            url.query_pairs_mut().append_pair("sid", &session.sid);
            if let Some(cookie) = session.cookie(base) {
                extra.push(("cookie".to_string(), cookie));
            }
        }
        self.open_socket_with(&url, &[], &extra).await
    }

    async fn mqtt(mut self) {
        let opened = tokio::select! {
            _ = self.stop.cancelled() => return,
            opened = self.open_mqtt() => opened,
        };
        let mut connection = match opened {
            Ok(connection) => connection,
            Err(error) => return self.fail(error.to_string()),
        };
        let client_id = self.payload["clientId"]
            .as_str()
            .filter(|c| !c.is_empty())
            .map(String::from)
            .unwrap_or_else(|| format!("nexo-{}", self.id));
        let mut connect = Connect::new(client_id);
        connect.keep_alive = 60;
        connect.clean_session = self.payload["clean"] != false;
        if let Some(username) = self.payload["username"].as_str().filter(|u| !u.is_empty()) {
            connect.set_login(username, self.payload["password"].as_str().unwrap_or(""));
        }
        if let Err(error) = connection.send(&Packet::Connect(connect)).await {
            return self.fail(error);
        }
        let topic = self.payload["topic"]
            .as_str()
            .filter(|t| !t.is_empty())
            .map(String::from);
        let subscribe_qos = qos(&self.payload["qos"]);
        let mut packet_id: u16 = 0;
        let mut next_id = move || {
            packet_id = packet_id.checked_add(1).unwrap_or(1);
            packet_id
        };
        let deadline = tokio::time::sleep(CONNECT_TIMEOUT);
        tokio::pin!(deadline);
        let mut keep_alive = tokio::time::interval(Duration::from_secs(60));
        keep_alive.tick().await;
        enum Step {
            Stop,
            Timeout,
            Command(Option<Command>),
            Ping,
            Received(std::result::Result<Option<Packet>, String>),
        }
        loop {
            let step = tokio::select! {
                _ = self.stop.cancelled() => Step::Stop,
                _ = &mut deadline, if self.events.state() == "connecting" => Step::Timeout,
                command = self.commands.recv() => Step::Command(command),
                _ = keep_alive.tick() => Step::Ping,
                packet = connection.next() => Step::Received(packet),
            };
            let reply = match step {
                Step::Stop => {
                    let _ = connection.send(&Packet::Disconnect).await;
                    return;
                }
                Step::Timeout => return self.fail("connack timeout".into()),
                Step::Command(None) => continue,
                Step::Command(Some(command)) => match command {
                    Command::Publish {
                        topic,
                        message,
                        qos,
                        retain,
                    } => {
                        let mut publish = Publish::new(topic, qos, message.into_bytes());
                        publish.retain = retain;
                        if qos != QoS::AtMostOnce {
                            publish.pkid = next_id();
                        }
                        Some(Packet::Publish(publish))
                    }
                    Command::Subscribe { topic, qos } => {
                        let mut subscribe = Subscribe::new(topic, qos);
                        subscribe.pkid = next_id();
                        Some(Packet::Subscribe(subscribe))
                    }
                    Command::Unsubscribe(topic) => {
                        let mut unsubscribe = Unsubscribe::new(topic);
                        unsubscribe.pkid = next_id();
                        Some(Packet::Unsubscribe(unsubscribe))
                    }
                    _ => None,
                },
                Step::Ping => (self.events.state() == "connected").then_some(Packet::PingReq),
                Step::Received(Ok(Some(packet))) => match packet {
                    Packet::ConnAck(ack) if ack.code == ConnectReturnCode::Success => {
                        self.events.set("connected");
                        self.events.emit("open", json!("Connected"));
                        topic.clone().map(|topic| {
                            let mut subscribe = Subscribe::new(topic, subscribe_qos);
                            subscribe.pkid = next_id();
                            Packet::Subscribe(subscribe)
                        })
                    }
                    Packet::ConnAck(ack) => {
                        return self
                            .fail(format!("The broker refused the connection: {:?}", ack.code));
                    }
                    Packet::Publish(publish) => {
                        self.events.emit(
                            "message",
                            json!({
                                "topic": publish.topic,
                                "text": String::from_utf8_lossy(&publish.payload),
                                "qos": publish.qos as u8,
                                "retain": publish.retain,
                            }),
                        );
                        match publish.qos {
                            QoS::AtMostOnce => None,
                            QoS::AtLeastOnce => Some(Packet::PubAck(PubAck::new(publish.pkid))),
                            QoS::ExactlyOnce => Some(Packet::PubRec(PubRec::new(publish.pkid))),
                        }
                    }
                    Packet::PubRec(record) => Some(Packet::PubRel(PubRel::new(record.pkid))),
                    Packet::PubRel(release) => Some(Packet::PubComp(PubComp::new(release.pkid))),
                    Packet::SubAck(ack) => {
                        if ack
                            .return_codes
                            .iter()
                            .any(|code| matches!(code, SubscribeReasonCode::Failure))
                        {
                            self.events
                                .emit("error", json!("Subscription rejected by the broker"));
                        }
                        None
                    }
                    Packet::Disconnect => {
                        self.events.emit("close", json!("Disconnected"));
                        self.events.set("closed");
                        return;
                    }
                    _ => None,
                },
                Step::Received(Ok(None)) => {
                    if self.events.state() == "connecting" {
                        return self.fail("The broker closed the connection".into());
                    }
                    self.events.emit("close", json!("Disconnected"));
                    self.events.set("closed");
                    return;
                }
                Step::Received(Err(error)) => {
                    self.events.emit("error", json!(error));
                    self.events.emit("close", json!("Disconnected"));
                    self.events.set(if self.events.state() == "connecting" {
                        "error"
                    } else {
                        "closed"
                    });
                    return;
                }
            };
            if let Some(packet) = reply
                && let Err(error) = connection.send(&packet).await
            {
                self.events.emit("error", json!(error));
                self.events.emit("close", json!("Disconnected"));
                self.events.set("closed");
                return;
            }
        }
    }
    /// Opens TCP, TLS or WebSocket to the addresses the egress policy approved.
    async fn open_mqtt(&self) -> Result<mqtt::Connection> {
        if matches!(self.url.scheme(), "ws" | "wss") {
            let socket = self.open_socket(&self.url, &["mqtt".to_string()]).await?;
            return Ok(mqtt::Connection::new(mqtt::Link::Socket(Box::new(socket))));
        }
        let connect = async {
            let stream = tokio::net::TcpStream::connect(&self.addresses[..])
                .await
                .map_err(|error| invalid(error.to_string()))?;
            let Some(config) = self.tls.clone() else {
                return Ok(mqtt::Link::Stream(Box::new(stream)));
            };
            let host = self.url.host_str().unwrap_or_default().to_string();
            let name = rustls_pki_types::ServerName::try_from(host)
                .map_err(|error| invalid(error.to_string()))?;
            let secured = tokio_rustls::TlsConnector::from(config)
                .connect(name, stream)
                .await
                .map_err(|error| invalid(error.to_string()))?;
            Ok(mqtt::Link::Stream(Box::new(secured)))
        };
        let link = tokio::time::timeout(CONNECT_TIMEOUT, connect)
            .await
            .map_err(|_| invalid("Connection timed out"))??;
        Ok(mqtt::Connection::new(link))
    }
}

/// Splits a Socket.IO packet into type, namespace and JSON data.
#[cfg(test)]
#[allow(clippy::result_large_err)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    fn realtime() -> Realtime {
        Realtime::new(Policy::AllowAll, Arc::new(Vec::new))
    }
    async fn wait_for(realtime: &Realtime, id: &str, check: impl Fn(&Value) -> bool) -> Value {
        for _ in 0..200 {
            let polled = realtime.poll(&json!({"id": id})).unwrap();
            if check(&polled) {
                return polled;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!(
            "condition not reached: {}",
            realtime.poll(&json!({"id": id})).unwrap()
        );
    }

    #[tokio::test]
    async fn websocket_echo_and_close() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_hdr_async(
                stream,
                |request: &tokio_tungstenite::tungstenite::handshake::server::Request, response| {
                    assert_eq!(request.headers()["x-test"], "1");
                    Ok(response)
                },
            )
            .await
            .unwrap();
            while let Some(Ok(message)) = socket.next().await {
                if message.is_text() {
                    socket
                        .send(Message::text(format!(
                            "echo:{}",
                            message.to_text().unwrap()
                        )))
                        .await
                        .unwrap();
                    socket.send(Message::binary(vec![1u8, 2])).await.unwrap();
                    socket.close(None).await.unwrap();
                }
            }
        });
        let realtime = realtime();
        let connected = realtime
            .connect(&json!({"protocol": "websocket", "url": format!("ws://{address}"), "headers": [{"key": "x-test", "value": "1"}]}))
            .await
            .unwrap();
        let id = connected["id"].as_str().unwrap();
        wait_for(&realtime, id, |p| p["state"] == "connected").await;
        realtime.send(&json!({"id": id, "message": "hi"})).unwrap();
        let polled = wait_for(&realtime, id, |p| p["state"] == "closed").await;
        let events = polled["events"].as_array().unwrap();
        assert_eq!(
            events[1]["data"],
            json!({"text": "echo:hi", "binary": false})
        );
        assert_eq!(events[2]["data"], json!({"text": "AQI=", "binary": true}));
        assert_eq!(events[3]["type"], "close");
        let later = realtime.poll(&json!({"id": id, "after": 3})).unwrap();
        assert_eq!(later["events"].as_array().unwrap().len(), 1);
        assert_eq!(realtime.list().as_array().unwrap().len(), 1);
        realtime.disconnect(&json!({"id": id})).unwrap();
        assert!(realtime.poll(&json!({"id": id})).is_err());
    }

    #[tokio::test]
    async fn socketio_handshake_events_and_emit() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_hdr_async(
                stream,
                |request: &tokio_tungstenite::tungstenite::handshake::server::Request, response| {
                    assert_eq!(request.uri().path(), "/socket.io/");
                    assert!(request.uri().query().unwrap().contains("EIO=4"));
                    Ok(response)
                },
            )
            .await
            .unwrap();
            socket
                .send(Message::text(
                    "0{\"sid\":\"e\",\"pingInterval\":25000,\"pingTimeout\":20000}",
                ))
                .await
                .unwrap();
            while let Some(Ok(message)) = socket.next().await {
                let text = message.to_text().unwrap().to_string();
                if text == "40{\"token\":\"t\"}" {
                    socket
                        .send(Message::text("40{\"sid\":\"s1\"}"))
                        .await
                        .unwrap();
                    socket.send(Message::text("2")).await.unwrap();
                    socket
                        .send(Message::text("42[\"welcome\",{\"a\":1}]"))
                        .await
                        .unwrap();
                } else if let Some(packet) = text.strip_prefix("42") {
                    socket
                        .send(Message::text(format!("42[\"echo\",{packet}]")))
                        .await
                        .unwrap();
                } else if text == "3" {
                    socket.send(Message::text("42[\"pong\"]")).await.unwrap();
                }
            }
        });
        let realtime = realtime();
        let connected = realtime
            .connect(&json!({"protocol": "socketio", "url": format!("http://{address}"), "auth": {"token": "t"}, "transports": "websocket"}))
            .await
            .unwrap();
        let id = connected["id"].as_str().unwrap();
        let polled = wait_for(&realtime, id, |p| {
            p["events"].as_array().unwrap().len() >= 4
        })
        .await;
        assert_eq!(polled["events"][0]["data"], "s1");
        assert_eq!(polled["events"][1]["type"], "transport");
        assert_eq!(polled["events"][1]["data"], "websocket");
        realtime
            .send(&json!({"id": id, "event": "say", "message": "{\"b\":2}"}))
            .unwrap();
        let polled = wait_for(&realtime, id, |p| {
            p["events"].as_array().unwrap().len() >= 5
        })
        .await;
        let data: Vec<Value> = polled["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["data"].clone())
            .collect();
        assert!(
            data.contains(&json!({"event": "welcome", "data": [{"a": 1}]})),
            "{data:?}"
        );
        assert!(
            data.contains(&json!({"event": "pong", "data": []})),
            "{data:?}"
        );
        assert!(
            data.contains(&json!({"event": "echo", "data": [["say", {"b": 2}]]})),
            "{data:?}"
        );
        realtime.disconnect(&json!({"id": id})).unwrap();
    }

    #[tokio::test]
    async fn kafka_lists_topics_produces_and_reads() {
        let (port, _) = crate::kafka::tests::start(Default::default()).await;
        let realtime = realtime();
        let connected = realtime
            .connect(&json!({"protocol": "kafka", "url": format!("127.0.0.1:{port}")}))
            .await
            .unwrap();
        let id = connected["id"].as_str().unwrap();
        let has = |kind: &'static str| {
            move |polled: &Value| {
                polled["events"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|event| event["type"] == kind)
            }
        };
        let polled = wait_for(&realtime, id, has("topics")).await;
        assert_eq!(polled["state"], "connected");
        let topics = polled["events"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["type"] == "topics")
            .unwrap();
        assert_eq!(
            topics["data"],
            json!([{"name": "orders", "partitions": 2, "internal": false}])
        );

        realtime
            .send(
                &json!({"id": id, "action": "produce", "topic": "orders", "partition": 1,
                "key": "k1", "message": "hello", "headers": [{"key": "trace", "value": "t1"}]}),
            )
            .unwrap();
        wait_for(&realtime, id, has("produced")).await;
        realtime
            .send(&json!({"id": id, "action": "subscribe", "topic": "orders", "from": "earliest"}))
            .unwrap();
        let polled = wait_for(&realtime, id, has("message")).await;
        let message = polled["events"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["type"] == "message")
            .unwrap();
        assert_eq!(message["data"]["value"], "hello");
        assert_eq!(message["data"]["key"], "k1");
        assert_eq!(message["data"]["headers"], json!({"trace": "t1"}));
        assert_eq!(
            (
                message["data"]["partition"].clone(),
                message["data"]["offset"].clone()
            ),
            (json!(1), json!(0))
        );
        realtime
            .send(&json!({"id": id, "action": "unsubscribe"}))
            .unwrap();
        wait_for(&realtime, id, has("unsubscribed")).await;
        realtime
            .send(&json!({"id": id, "action": "topics"}))
            .unwrap();
        assert!(
            realtime
                .send(&json!({"id": id, "action": "produce"}))
                .unwrap_err()
                .to_string()
                .contains("Kafka topic")
        );
        assert!(
            realtime
                .send(&json!({"id": id, "action": "rewind", "topic": "a"}))
                .is_err()
        );
        realtime.disconnect(&json!({"id": id})).unwrap();

        assert!(
            realtime
                .connect(&json!({"protocol": "kafka", "url": ""}))
                .await
                .is_err()
        );
        let refused = realtime
            .connect(&json!({"protocol": "kafka", "url": "127.0.0.1:9"}))
            .await
            .unwrap();
        let polled = wait_for(&realtime, refused["id"].as_str().unwrap(), |p| {
            p["state"] == "error"
        })
        .await;
        assert!(
            polled["events"][0]["data"]
                .as_str()
                .unwrap()
                .contains("127.0.0.1:9")
        );
    }

    #[test]
    fn credentials_come_from_the_vault_for_their_hosts() {
        let payload = json!({"url": "mqtt://broker.example.com", "username": "u", "password": "{{vault:mqtt}}",
            "resolvedSecrets": {"mqtt": "s3cret"}, "secretHosts": {"mqtt": ["*.example.com"]}});
        assert_eq!(with_credentials(&payload).unwrap()["password"], "s3cret");
        let mut elsewhere = payload.clone();
        elsewhere["url"] = json!("mqtt://evil.test");
        assert!(
            with_credentials(&elsewhere)
                .unwrap_err()
                .to_string()
                .contains("Secret mqtt cannot be sent to evil.test")
        );
        let plain = json!({"url": "mqtt://x", "password": "literal"});
        assert_eq!(with_credentials(&plain).unwrap(), plain);
    }

    #[tokio::test]
    async fn rejects_bad_protocols_and_blocked_destinations() {
        let realtime = realtime();
        assert!(
            realtime
                .connect(&json!({"protocol": "ftp", "url": "ftp://x"}))
                .await
                .is_err()
        );
        assert!(
            realtime
                .connect(&json!({"protocol": "websocket", "url": "http://x"}))
                .await
                .is_err()
        );
        let blocked = Realtime::new(
            Policy::parse(Some("deny-private"), None),
            Arc::new(Vec::new),
        );
        assert!(
            blocked
                .connect(&json!({"protocol": "websocket", "url": "ws://127.0.0.1:9"}))
                .await
                .is_err()
        );
    }
}
