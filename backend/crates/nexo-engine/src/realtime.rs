//! WebSocket, Socket.IO and MQTT connections whose events clients read by polling.
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
    collections::{HashMap, VecDeque},
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
        let allowed: &[&str] = match protocol {
            "websocket" => &["ws", "wss"],
            "mqtt" => &["mqtt", "mqtts", "ws", "wss"],
            "socketio" => &["http", "https"],
            _ => return Err(invalid("Select WebSocket, Socket.IO or MQTT")),
        };
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
        };
        match protocol {
            "websocket" => tokio::spawn(task.websocket()),
            "socketio" => tokio::spawn(task.socketio()),
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
}
impl Task {
    fn fail(&self, message: String) {
        self.events.emit("error", json!(message));
        self.events.set("error");
    }
    /// Opens a WebSocket to the address the egress policy approved.
    async fn open_socket(&self, url: &Url, protocols: &[String]) -> Result<Socket> {
        let mut request = url
            .as_str()
            .into_client_request()
            .map_err(|error| invalid(error.to_string()))?;
        for (key, value) in header_rows(&self.payload["headers"]) {
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

    /// Socket.IO v4 (Engine.IO v4) over a WebSocket, without long polling.
    async fn socketio(mut self) {
        let mut url = self.url.clone();
        let namespace = match url.path() {
            "" | "/" => "/".to_string(),
            path => path.trim_end_matches('/').to_string(),
        };
        let _ = url.set_scheme(if url.scheme() == "https" { "wss" } else { "ws" });
        let path = self.payload["path"]
            .as_str()
            .filter(|p| !p.is_empty())
            .unwrap_or("/socket.io");
        url.set_path(&format!("{}/", path.trim_end_matches('/')));
        url.query_pairs_mut()
            .append_pair("EIO", "4")
            .append_pair("transport", "websocket");
        let opened = tokio::select! {
            _ = self.stop.cancelled() => return,
            opened = self.open_socket(&url, &[]) => opened,
        };
        let mut socket = match opened {
            Ok(socket) => socket,
            Err(error) => return self.fail(error.to_string()),
        };
        let prefix = if namespace == "/" {
            String::new()
        } else {
            format!("{namespace},")
        };
        let auth = if self.payload["auth"].is_object() {
            self.payload["auth"].to_string()
        } else {
            String::new()
        };
        let deadline = tokio::time::sleep(CONNECT_TIMEOUT);
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                _ = self.stop.cancelled() => {
                    let _ = socket.send(Message::text(format!("41{prefix}"))).await;
                    let _ = socket.close(None).await;
                    return;
                }
                _ = &mut deadline, if self.events.state() == "connecting" => {
                    let _ = socket.close(None).await;
                    return self.fail("timeout".into());
                }
                command = self.commands.recv() => {
                    if let Some(Command::Emit { event, value }) = command {
                        let packet = json!([event, value]).to_string();
                        if let Err(error) = socket.send(Message::text(format!("42{prefix}{packet}"))).await {
                            self.events.emit("error", json!(error.to_string()));
                        }
                    }
                }
                message = socket.next() => {
                    let text = match message {
                        Some(Ok(Message::Text(text))) => text.to_string(),
                        Some(Ok(Message::Close(_))) | None => {
                            if self.events.state() == "connecting" {
                                return self.fail("websocket error".into());
                            }
                            self.events.emit("close", json!("transport close"));
                            self.events.set("closed");
                            return;
                        }
                        Some(Ok(_)) => continue,
                        Some(Err(error)) => return self.fail(error.to_string()),
                    };
                    match text.as_bytes().first() {
                        Some(b'0') => {
                            let _ = socket.send(Message::text(format!("40{prefix}{auth}"))).await;
                        }
                        Some(b'2') => {
                            let _ = socket.send(Message::text("3")).await;
                        }
                        Some(b'1') => {
                            self.events.emit("close", json!("transport close"));
                            self.events.set("closed");
                            return;
                        }
                        Some(b'4') => {
                            let Some((kind, packet_namespace, data)) = socketio_packet(&text[1..]) else { continue };
                            if packet_namespace != namespace {
                                continue;
                            }
                            match kind {
                                b'0' => {
                                    self.events.set("connected");
                                    self.events.emit("open", data.get("sid").cloned().unwrap_or(json!(self.id)));
                                }
                                b'1' => {
                                    self.events.emit("close", json!("io server disconnect"));
                                    self.events.set("closed");
                                    let _ = socket.close(None).await;
                                    return;
                                }
                                b'2' => {
                                    if let Some(items) = data.as_array()
                                        && let Some((event, rest)) = items.split_first()
                                    {
                                        self.events.emit("message", json!({"event": event, "data": rest}));
                                    }
                                }
                                b'4' => {
                                    let _ = socket.close(None).await;
                                    let message = data["message"].as_str().map(String::from).unwrap_or_else(|| data.to_string());
                                    return self.fail(message);
                                }
                                b'5' => self.events.emit("message", json!({"event": "binary", "data": ["Binary Socket.IO events are not supported"]})),
                                _ => {}
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
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
fn socketio_packet(text: &str) -> Option<(u8, String, Value)> {
    let bytes = text.as_bytes();
    let kind = *bytes.first()?;
    let mut rest = &text[1..];
    if kind == b'5' || kind == b'6' {
        let dash = rest.find('-')?;
        rest = &rest[dash + 1..];
    }
    let mut namespace = "/".to_string();
    if rest.starts_with('/') {
        let end = rest.find(',').unwrap_or(rest.len());
        namespace = rest[..end].to_string();
        rest = rest.get(end + 1..).unwrap_or("");
    }
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    rest = &rest[digits..];
    let data = if rest.is_empty() {
        Value::Null
    } else {
        serde_json::from_str(rest).ok()?
    };
    Some((kind, namespace, data))
}

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

    #[test]
    fn parses_socketio_packets() {
        assert_eq!(
            socketio_packet("2[\"hi\",1]").unwrap(),
            (b'2', "/".into(), json!(["hi", 1]))
        );
        assert_eq!(
            socketio_packet("0/admin,{\"sid\":\"x\"}").unwrap(),
            (b'0', "/admin".into(), json!({"sid": "x"}))
        );
        assert_eq!(socketio_packet("212[\"ack\"]").unwrap().2, json!(["ack"]));
        assert_eq!(
            socketio_packet("1").unwrap(),
            (b'1', "/".into(), Value::Null)
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
            .connect(&json!({"protocol": "socketio", "url": format!("http://{address}"), "auth": {"token": "t"}}))
            .await
            .unwrap();
        let id = connected["id"].as_str().unwrap();
        let polled = wait_for(&realtime, id, |p| {
            p["events"].as_array().unwrap().len() >= 3
        })
        .await;
        assert_eq!(polled["events"][0]["data"], "s1");
        realtime
            .send(&json!({"id": id, "event": "say", "message": "{\"b\":2}"}))
            .unwrap();
        let polled = wait_for(&realtime, id, |p| {
            p["events"].as_array().unwrap().len() >= 4
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
