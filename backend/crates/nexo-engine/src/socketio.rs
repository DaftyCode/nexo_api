//! Socket.IO v4 over Engine.IO v4: packets, long-polling payloads and binary attachments.
//!
//! Only the encoding is here, so it can be tested without a network; `realtime` moves the
//! packets over WebSocket or HTTP long polling. Binary data is shown and written as
//! `{"$binary": "<base64>"}`: Socket.IO sends it as attachments that the JSON references with
//! `{"_placeholder": true, "num": n}`.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Map, Value, json};

/// Separates the packets of one long-polling request or answer.
pub const SEPARATOR: char = '\u{1e}';
/// The most attachments one packet may announce.
const MAX_ATTACHMENTS: usize = 64;

/// An Engine.IO packet as one transport carries it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Frame {
    Text(String),
    Binary(Vec<u8>),
}

/// The packets of a long-polling answer: text packets, and `b` + base64 for binary ones.
pub fn decode_payload(body: &str) -> Vec<Frame> {
    body.split(SEPARATOR)
        .filter(|packet| !packet.is_empty())
        .map(|packet| match packet.strip_prefix('b') {
            Some(encoded) => STANDARD
                .decode(encoded)
                .map(Frame::Binary)
                .unwrap_or_else(|_| Frame::Text(packet.to_string())),
            None => Frame::Text(packet.to_string()),
        })
        .collect()
}
/// The body of a long-polling request carrying the frames.
pub fn encode_payload(frames: &[Frame]) -> String {
    frames
        .iter()
        .map(|frame| match frame {
            Frame::Text(text) => text.clone(),
            Frame::Binary(bytes) => format!("b{}", STANDARD.encode(bytes)),
        })
        .collect::<Vec<_>>()
        .join(&SEPARATOR.to_string())
}

/// The Engine.IO `open` packet: session id, timing and the transports to upgrade to.
#[derive(Clone, Debug, PartialEq)]
pub struct Handshake {
    pub sid: String,
    pub upgrades: Vec<String>,
    pub ping_interval: u64,
    pub ping_timeout: u64,
}
pub fn handshake(text: &str) -> Option<Handshake> {
    let value: Value = serde_json::from_str(text.strip_prefix('0')?).ok()?;
    Some(Handshake {
        sid: value["sid"].as_str()?.to_string(),
        upgrades: value["upgrades"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(String::from)
            .collect(),
        ping_interval: value["pingInterval"].as_u64().unwrap_or(25_000),
        ping_timeout: value["pingTimeout"].as_u64().unwrap_or(20_000),
    })
}

/// A Socket.IO packet, with binary attachments already put back in place.
#[derive(Clone, Debug, PartialEq)]
pub struct Packet {
    /// `0` connect, `1` disconnect, `2` event, `3` ack, `4` connect error, `5` binary event,
    /// `6` binary ack.
    pub kind: u8,
    pub namespace: String,
    pub id: Option<u64>,
    pub data: Value,
}

/// A text packet: its type, attachment count, namespace, id and JSON data.
fn parse(text: &str) -> Option<(Packet, usize)> {
    let kind = text.bytes().next()?.checked_sub(b'0')?;
    if kind > 6 {
        return None;
    }
    let mut rest = &text[1..];
    let mut attachments = 0;
    if kind == 5 || kind == 6 {
        let dash = rest.find('-')?;
        attachments = rest[..dash].parse().ok()?;
        rest = &rest[dash + 1..];
    }
    let mut namespace = "/".to_string();
    if rest.starts_with('/') {
        let end = rest.find(',').unwrap_or(rest.len());
        namespace = rest[..end].to_string();
        rest = rest.get(end + 1..).unwrap_or("");
    }
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    let id = rest[..digits].parse().ok();
    rest = &rest[digits..];
    let data = if rest.is_empty() {
        Value::Null
    } else {
        serde_json::from_str(rest).ok()?
    };
    Some((
        Packet {
            kind,
            namespace,
            id,
            data,
        },
        attachments,
    ))
}

/// Reads Socket.IO packets as they arrive: a binary packet is complete once its attachments,
/// which come as separate binary frames, have arrived.
#[derive(Default)]
pub struct Decoder {
    pending: Option<(Packet, usize, Vec<Vec<u8>>)>,
}
impl Decoder {
    /// A Socket.IO text packet (an Engine.IO message without its `4`).
    pub fn text(&mut self, text: &str) -> Option<Packet> {
        let (packet, attachments) = parse(text)?;
        if attachments == 0 {
            return Some(packet);
        }
        if attachments > MAX_ATTACHMENTS {
            return None;
        }
        self.pending = Some((packet, attachments, Vec::new()));
        None
    }
    /// An attachment of the packet waiting for it.
    pub fn binary(&mut self, bytes: Vec<u8>) -> Option<Packet> {
        let (_, expected, buffers) = self.pending.as_mut()?;
        buffers.push(bytes);
        if buffers.len() < *expected {
            return None;
        }
        let (mut packet, _, buffers) = self.pending.take()?;
        packet.data = restore(packet.data, &buffers);
        Some(packet)
    }
}

/// Puts each attachment where its placeholder is, as `{"$binary": base64}`.
fn restore(value: Value, buffers: &[Vec<u8>]) -> Value {
    match value {
        Value::Object(map) if map.get("_placeholder") == Some(&Value::Bool(true)) => map
            .get("num")
            .and_then(Value::as_u64)
            .and_then(|num| buffers.get(num as usize))
            .map(|bytes| json!({"$binary": STANDARD.encode(bytes)}))
            .unwrap_or(Value::Object(map)),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, item)| (key, restore(item, buffers)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| restore(item, buffers))
                .collect(),
        ),
        other => other,
    }
}

/// Replaces each `{"$binary": base64}` with a placeholder and collects its bytes.
fn extract(value: &Value, buffers: &mut Vec<Vec<u8>>) -> Result<Value, String> {
    match value {
        Value::Object(map) if map.len() == 1 && map.contains_key("$binary") => {
            let encoded = map["$binary"].as_str().unwrap_or_default();
            let bytes = STANDARD
                .decode(encoded)
                .map_err(|_| "A $binary value must be base64".to_string())?;
            buffers.push(bytes);
            Ok(json!({"_placeholder": true, "num": buffers.len() - 1}))
        }
        Value::Object(map) => Ok(Value::Object(
            map.iter()
                .map(|(key, item)| Ok((key.clone(), extract(item, buffers)?)))
                .collect::<Result<Map<_, _>, String>>()?,
        )),
        Value::Array(items) => Ok(Value::Array(
            items
                .iter()
                .map(|item| extract(item, buffers))
                .collect::<Result<_, _>>()?,
        )),
        other => Ok(other.clone()),
    }
}

/// The frames of an event: an Engine.IO message (`4`) with the Socket.IO packet, followed by
/// its attachments when the value holds `{"$binary": base64}` data.
pub fn event(namespace: &str, event: &str, value: &Value) -> Result<Vec<Frame>, String> {
    let mut buffers = Vec::new();
    let data = extract(&json!([event, value]), &mut buffers)?;
    let prefix = if namespace == "/" {
        String::new()
    } else {
        format!("{namespace},")
    };
    let packet = if buffers.is_empty() {
        format!("42{prefix}{data}")
    } else {
        format!("45{}-{prefix}{data}", buffers.len())
    };
    let mut frames = vec![Frame::Text(packet)];
    frames.extend(buffers.into_iter().map(Frame::Binary));
    Ok(frames)
}

/// Connects to the namespace, with the `auth` payload when there is one.
pub fn connect(namespace: &str, auth: &Value) -> String {
    let prefix = if namespace == "/" {
        String::new()
    } else {
        format!("{namespace},")
    };
    if auth.is_object() {
        format!("40{prefix}{auth}")
    } else {
        format!("40{prefix}")
    }
}
/// Leaves the namespace.
pub fn disconnect(namespace: &str) -> String {
    if namespace == "/" {
        "41".to_string()
    } else {
        format!("41{namespace},")
    }
}

#[cfg(test)]
mod tests;
