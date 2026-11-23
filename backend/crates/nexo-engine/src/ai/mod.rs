//! The AI assistant's calls (IA-01). A chat streams its answer in the background while the
//! interface asks for what arrived (`ai.poll`), as realtime connections do, and `ai.stop`
//! ends it. Each call goes through the transport of requests: the egress policy, the route
//! of the settings (a proxy or an SSH tunnel) and TLS with aws-lc-rs. The key comes from the
//! vault, filled in by the application, and is never part of an answer.
mod stream;
pub mod wire;

use crate::{
    egress::Policy,
    transport::{Options, Transport, parse_url, read_limited},
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
use wire::Settings;

/// Chats that run at once.
const RUNNING: usize = 8;
/// Bytes of an answer kept at most.
const MAX_ANSWER: usize = 1 << 20;
/// How long a finished chat waits to be read.
const KEPT: Duration = Duration::from_secs(300);
/// How long an answer may take in all.
const TIMEOUT: Duration = Duration::from_secs(600);
/// Pages of a list of models read at most.
const MODEL_PAGES: usize = 10;

type Ports = Arc<dyn Fn() -> Vec<u16> + Send + Sync>;

#[derive(Default)]
struct State {
    text: String,
    done: bool,
    stop: Option<String>,
    error: Option<String>,
    input: u64,
    output: u64,
    ended: Option<Instant>,
}

struct Chat {
    state: Mutex<State>,
    stop: CancellationToken,
}

pub struct Assistant {
    egress: Policy,
    ports: Ports,
    chats: Mutex<HashMap<String, Arc<Chat>>>,
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
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
        let ports = (self.ports)();
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

    /// `ai.models`: the models the provider lists for the key.
    pub async fn models(&self, payload: &Value) -> Result<Value> {
        let settings = settings(payload)?;
        let first = wire::models(&settings, None);
        let transport = self.transport(&parse_url(&first.url)?, payload).await?;
        let mut found: Vec<wire::Model> = Vec::new();
        let mut call = first;
        for _ in 0..MODEL_PAGES {
            let response = transport.get(&parse_url(&call.url)?, &call.headers).await?;
            let status = response.status().as_u16();
            let body = read_limited(response, 8 * 1024 * 1024).await?;
            if !(200..300).contains(&status) {
                return Err(Error::Validation(wire::failure(status, &body, None)));
            }
            let body: Value = serde_json::from_str(&body).map_err(|_| {
                Error::Validation("The provider did not answer a list of models".into())
            })?;
            let (page, next) = wire::model_page(settings.provider, &body);
            for model in page {
                if !found.iter().any(|seen| seen.id == model.id) {
                    found.push(model);
                }
            }
            match next {
                Some(after) => call = wire::models(&settings, Some(&after)),
                None => break,
            }
        }
        let models: Vec<Value> = found
            .iter()
            .map(|model| json!({"id": model.id, "name": model.name}))
            .collect();
        Ok(json!({"models": models}))
    }

    /// `ai.chat`: starts the answer to a conversation and gives its id.
    pub async fn start(&self, payload: &Value) -> Result<Value> {
        let settings = settings(payload)?;
        let messages: Vec<Message> = serde_json::from_value(payload["messages"].clone())
            .map_err(|_| Error::Validation("The conversation is not valid".into()))?;
        let system = text(&payload["system"]);
        let messages = ai::conversation(messages, Some(system))?;
        let call = wire::chat(&settings, &messages, system)?;
        let url = parse_url(&call.url)?;
        let transport = self.transport(&url, payload).await?;
        let chat = Arc::new(Chat {
            state: Mutex::default(),
            stop: CancellationToken::new(),
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
        tokio::spawn(stream::run(chat, transport, url, call, settings.provider));
        Ok(json!({"id": id}))
    }

    /// `ai.poll`: what the answer gained since `after` (a length already read), and whether it
    /// ended. An ended answer is read once.
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
        let mut start = (payload["after"].as_u64().unwrap_or(0) as usize).min(state.text.len());
        while !state.text.is_char_boundary(start) {
            start -= 1;
        }
        let answer = json!({
            "text": &state.text[start..],
            "next": state.text.len(),
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
