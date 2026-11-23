//! The AI assistant's calls (IA-01). A chat streams its answer in the background while the
//! interface asks for what arrived (`ai.poll`), as realtime connections do, and `ai.stop`
//! ends it. When the model asks for tools, the chat waits: the application runs them and
//! `ai.continue` gives their answers back, in the same chat. Each call goes through the
//! transport of requests: the egress policy, the route of the settings (a proxy or an SSH
//! tunnel) and TLS with aws-lc-rs. The key comes from the vault, filled in by the
//! application, and is never part of an answer.
mod listing;
mod resume;
mod stream;
pub mod wire;

use crate::{
    egress::Policy,
    transport::{Options, Transport, parse_url},
};
use nexo_domain::{
    Error, Result,
    ai::{self, Message, Provider},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;
use url::Url;
use wire::{Settings, Tool, ToolCall};

/// Chats that run at once.
const RUNNING: usize = 8;
/// Bytes of an answer kept at most.
const MAX_ANSWER: usize = 1 << 20;
/// How long a finished chat waits to be read.
const KEPT: Duration = Duration::from_secs(300);
/// How long an answer may take in all.
const TIMEOUT: Duration = Duration::from_secs(600);

type Ports = Arc<dyn Fn() -> Vec<u16> + Send + Sync>;

#[derive(Default)]
struct State {
    text: String,
    /// What the model reasoned, apart from its answer.
    thinking: String,
    done: bool,
    stop: Option<String>,
    error: Option<String>,
    input: u64,
    output: u64,
    ended: Option<Instant>,
    /// The tools the model waits for.
    waiting: Vec<ToolCall>,
    /// The next text and reasoning start a new paragraph: they follow the reading of tools.
    separate: bool,
    separate_thinking: bool,
}

/// The conversation of a chat in the provider's words, to continue it after its tools.
struct Turns {
    settings: Settings,
    system: String,
    tools: Vec<Tool>,
    native: Vec<Value>,
    /// The last turn, while it waits for the answers of its tools.
    pending: Option<(Value, Vec<ToolCall>)>,
    rounds: usize,
}

struct Chat {
    state: Mutex<State>,
    turns: Mutex<Turns>,
    stop: CancellationToken,
    transport: Transport,
    url: Url,
}

pub struct Assistant {
    egress: Policy,
    ports: Ports,
    chats: Mutex<HashMap<String, Arc<Chat>>>,
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

/// What `all` gained after the length `after` already read, from a whole character.
fn since<'a>(all: &'a str, after: &Value) -> &'a str {
    let mut start = (after.as_u64().unwrap_or(0) as usize).min(all.len());
    while !all.is_char_boundary(start) {
        start -= 1;
    }
    &all[start..]
}

/// The provider, its address, the model and the key of a payload.
fn settings(payload: &Value) -> Result<Settings> {
    let provider = Provider::parse(text(&payload["provider"]))?;
    let key = payload["resolvedKey"]
        .as_str()
        .filter(|key| !key.is_empty())
        .map(String::from);
    if provider.needs_key() && key.is_none() {
        return Err(Error::Validation(
            "Paste the API key of the provider in Settings → AI assistant".into(),
        ));
    }
    Ok(Settings {
        provider,
        base: provider.base_url(payload["baseUrl"].as_str())?,
        model: text(&payload["model"]).trim().to_owned(),
        key,
        effort: ai::effort(payload["effort"].as_str())?,
    })
}

impl Assistant {
    pub fn new(egress: Policy, ports: Ports) -> Self {
        Self {
            egress,
            ports,
            chats: Mutex::default(),
        }
    }

    /// The destination passes the egress policy: here when it is reached directly, at the
    /// proxy or tunnel otherwise.
    async fn transport(&self, url: &Url, payload: &Value) -> Result<Transport> {
        // The port of the model run inside Nexo, set by the application only.
        let mut ports = (self.ports)();
        ports.extend(
            payload["egressLoopbackPorts"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|port| u16::try_from(port.as_u64()?).ok()),
        );
        let host = url.host_str().unwrap_or_default();
        let port = url.port_or_known_default().unwrap_or(443);
        if payload["route"].is_object() {
            self.egress.check_remote(host, port, &ports).await?;
        } else {
            self.egress.resolve(host, port, &ports).await?;
        }
        let options = Options {
            strict_ssl: true,
            follow_redirects: false,
            timeout: TIMEOUT,
            trust_redirect_credentials: false,
            transport: json!({"route": payload["route"], "caPem": payload["caPem"]}),
            egress: self.egress.clone(),
            loopback_ports: ports,
            profiles: payload["sshProfiles"].clone(),
            protection: None,
        };
        Transport::new(options, Arc::default())
    }

    /// `ai.chat`: starts the answer to a conversation and gives its id.
    pub async fn start(&self, payload: &Value) -> Result<Value> {
        let settings = settings(payload)?;
        let messages: Vec<Message> = serde_json::from_value(payload["messages"].clone())
            .map_err(|_| Error::Validation("The conversation is not valid".into()))?;
        let system = text(&payload["system"]).to_owned();
        let messages = ai::conversation(messages, Some(&system))?;
        let tools = wire::tools::parse(&payload["tools"])?;
        let native = wire::native(settings.provider, &messages);
        let call = wire::request(&settings, &native, &system, &tools)?;
        let url = parse_url(&call.url)?;
        let transport = self.transport(&url, payload).await?;
        let chat = Arc::new(Chat {
            state: Mutex::default(),
            turns: Mutex::new(Turns {
                settings,
                system,
                tools,
                native,
                pending: None,
                rounds: 0,
            }),
            stop: CancellationToken::new(),
            transport,
            url,
        });
        let id = uuid::Uuid::new_v4().to_string();
        {
            let mut chats = self.chats.lock().unwrap();
            chats.retain(|_, chat| {
                let state = chat.state.lock().unwrap();
                state.ended.is_none_or(|ended| ended.elapsed() < KEPT)
            });
            let running = chats
                .values()
                .filter(|chat| !chat.state.lock().unwrap().done)
                .count();
            if running >= RUNNING {
                return Err(Error::Validation(
                    "Too many answers are being written: wait for one to end".into(),
                ));
            }
            chats.insert(id.clone(), chat.clone());
        }
        tokio::spawn(stream::run(chat, call));
        Ok(json!({"id": id}))
    }

    /// `ai.poll`: what the answer gained since `after` (a length already read), what its
    /// reasoning gained since `thinkingAfter`, and whether it ended. An ended answer is read
    /// once.
    pub fn poll(&self, payload: &Value) -> Result<Value> {
        let id = text(&payload["id"]);
        let chat = self
            .chats
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or(Error::NotFound)?;
        let state = chat.state.lock().unwrap();
        let answer = json!({
            "text": since(&state.text, &payload["after"]),
            "next": state.text.len(),
            "thinking": since(&state.thinking, &payload["thinkingAfter"]),
            "thinkingNext": state.thinking.len(),
            "tools": state.waiting,
            "done": state.done,
            "stop": state.stop,
            "error": state.error,
            "usage": {"input": state.input, "output": state.output},
        });
        if state.done {
            drop(state);
            self.chats.lock().unwrap().remove(id);
        }
        Ok(answer)
    }

    /// `ai.stop`: ends an answer where it is.
    pub fn stop(&self, payload: &Value) -> Result<Value> {
        let found = self
            .chats
            .lock()
            .unwrap()
            .get(text(&payload["id"]))
            .cloned();
        if let Some(chat) = &found {
            chat.stop.cancel();
            // An answer that waits for its tools ends here too.
            let mut state = chat.state.lock().unwrap();
            if !state.waiting.is_empty() {
                state.waiting.clear();
                state.stop = Some("stopped".into());
                state.done = true;
                state.ended = Some(Instant::now());
                chat.turns.lock().unwrap().pending = None;
            }
        }
        Ok(json!({"stopped": found.is_some()}))
    }

    pub fn close(&self) {
        for chat in self.chats.lock().unwrap().values() {
            chat.stop.cancel();
        }
    }
}

#[cfg(test)]
mod tests;
