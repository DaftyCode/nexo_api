//! OAuth 2.0 sign-ins through the browser (authorization code, with or without PKCE, and
//! implicit), in the three ways the answer can come back:
//! - **loopback**: the Callback URL is on this computer, so Nexo listens on it;
//! - **relay**: "Authorize using browser" sends the provider to Nexo's callback page, which
//!   forwards the answer to a one-time local port named in `state` (like Postman's page);
//! - **manual**: the user pastes the address the browser returned to.
//!
//! Local listeners accept connections on 127.0.0.1 only, answer only the callback path, ignore
//! answers whose `state` is not this sign-in's and close once answered or after five minutes.
use axum::{
    Router,
    extract::State,
    http::{StatusCode, Uri},
    response::Html,
};
use nexo_domain::{Error, Result};
use serde_json::{Map, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::watch;
use url::Url;

use crate::{
    auth::text,
    oauth2::{self, Callback, Returned},
    vault::rand_bytes,
};

/// How long a sign-in waits for the provider's answer.
pub const LIFETIME: Duration = Duration::from_secs(300);

fn invalid(message: impl Into<String>) -> Error {
    Error::Validation(message.into())
}

/// One sign-in in progress.
pub struct Flow {
    pub auth: Map<String, Value>,
    pub authorization_url: Url,
    pub redirect_uri: String,
    pub verifier: Option<String>,
    state: String,
    started: Instant,
    /// The provider's answer, until it is read.
    returned: Mutex<Option<Vec<(String, String)>>>,
    outcome: Mutex<Option<std::result::Result<Value, String>>>,
    stop: watch::Sender<bool>,
}
impl Flow {
    pub fn expired(&self) -> bool {
        self.started.elapsed() > LIFETIME
    }
    pub fn set_returned(&self, parameters: Vec<(String, String)>) {
        *self.returned.lock().unwrap_or_else(|e| e.into_inner()) = Some(parameters);
    }
    pub fn take_returned(&self) -> Option<Vec<(String, String)>> {
        self.returned
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
    }
    pub fn read(&self, parameters: &[(String, String)], now_ms: u64) -> Result<Returned> {
        oauth2::read_return(parameters, &self.state, now_ms)
    }
    pub fn finish(&self, outcome: std::result::Result<Value, String>) {
        *self.outcome.lock().unwrap_or_else(|e| e.into_inner()) = Some(outcome);
        let _ = self.stop.send(true);
    }
    pub fn outcome(&self) -> Option<std::result::Result<Value, String>> {
        self.outcome
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

/// A started sign-in, as the interface needs it.
pub struct Started {
    pub id: String,
    pub authorization_url: Url,
    pub mode: &'static str,
    pub redirect_uri: String,
}

/// Sign-ins in progress.
#[derive(Default)]
pub struct Flows {
    flows: Mutex<HashMap<String, Arc<Flow>>>,
}
impl Flows {
    pub async fn start(&self, auth: Map<String, Value>, relay_url: &str) -> Result<Started> {
        if !oauth2::uses_browser(&auth) {
            return Err(invalid(
                "This grant type gets its token directly: use Get new access token",
            ));
        }
        self.sweep();
        let callback = oauth2::callback(&auth)?;
        let verifier = oauth2::pkce_verifier(&auth, &rand_bytes::<48>())?;
        let challenge = verifier
            .as_deref()
            .map(|v| oauth2::pkce_challenge(&auth, v));
        let chosen = text(auth.get("state")).trim().to_string();
        let base_state = if chosen.is_empty() {
            hex::encode(rand_bytes::<16>())
        } else {
            chosen
        };
        let (listener, redirect_uri, state, path, mode) = match callback {
            Callback::Loopback(url) => {
                let port = url.port_or_known_default().unwrap_or(80);
                let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
                    .await
                    .map_err(|error| {
                        invalid(format!(
                            "Cannot listen on the Callback URL port {port}: {error}"
                        ))
                    })?;
                let path = url.path().to_string();
                (
                    Some(listener),
                    url.to_string(),
                    base_state,
                    path,
                    "loopback",
                )
            }
            Callback::Relay => {
                let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                    .await
                    .map_err(|error| invalid(format!("Cannot open a local port: {error}")))?;
                let port = listener
                    .local_addr()
                    .map_err(|error| invalid(error.to_string()))?
                    .port();
                // The callback page reads the port from the end of `state`.
                let state = format!("{base_state}.{port}");
                (
                    Some(listener),
                    relay_url.to_string(),
                    state,
                    "/callback".to_string(),
                    "relay",
                )
            }
            Callback::Manual(url) => (None, url.to_string(), base_state, String::new(), "manual"),
        };
        let nonce = hex::encode(rand_bytes::<16>());
        let authorization_url = oauth2::authorization_url(
            &auth,
            &redirect_uri,
            &state,
            challenge.as_ref(),
            Some(&nonce),
        )?;
        let (stop, stopped) = watch::channel(false);
        let flow = Arc::new(Flow {
            auth,
            authorization_url: authorization_url.clone(),
            redirect_uri: redirect_uri.clone(),
            verifier,
            state,
            started: Instant::now(),
            returned: Mutex::new(None),
            outcome: Mutex::new(None),
            stop,
        });
        if let Some(listener) = listener {
            tokio::spawn(serve(listener, path, flow.clone(), stopped));
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.flows
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.clone(), flow);
        Ok(Started {
            id,
            authorization_url,
            mode,
            redirect_uri,
        })
    }
    pub fn get(&self, id: &str) -> Result<Arc<Flow>> {
        self.flows
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
            .ok_or_else(|| invalid("This sign-in is no longer in progress"))
    }
    pub fn remove(&self, id: &str) {
        if let Some(flow) = self
            .flows
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id)
        {
            let _ = flow.stop.send(true);
        }
    }
    /// Forgets sign-ins nobody asked about long after they expired.
    fn sweep(&self) {
        self.flows
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, flow| {
                let keep = flow.started.elapsed() < LIFETIME * 2;
                if !keep {
                    let _ = flow.stop.send(true);
                }
                keep
            });
    }
    /// Stops every listener, when the engine stops.
    pub fn close(&self) {
        for flow in self
            .flows
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
        {
            let _ = flow.stop.send(true);
        }
    }
}

const WAITING_PAGE: &str = r#"<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Nexo API</title><body style="font:16px system-ui;margin:3rem"><p>Completing the sign-in…</p><script>if(location.hash.length>1){location.replace(location.pathname+"?"+location.hash.slice(1))}</script>"#;
const DONE_PAGE: &str = r#"<!doctype html><meta charset="utf-8"><title>Nexo API</title><body style="font:16px system-ui;margin:3rem"><p>Signed in. You can close this tab and return to Nexo API.</p>"#;
const FOREIGN_PAGE: &str = r#"<!doctype html><meta charset="utf-8"><title>Nexo API</title><body style="font:16px system-ui;margin:3rem"><p>This answer does not belong to the sign-in started in Nexo API.</p>"#;

async fn serve(
    listener: tokio::net::TcpListener,
    path: String,
    flow: Arc<Flow>,
    mut stopped: watch::Receiver<bool>,
) {
    let app = Router::new()
        .fallback(answer)
        .with_state((flow, Arc::new(path)));
    let _ = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = tokio::time::timeout(LIFETIME, stopped.wait_for(|stop| *stop)).await;
        })
        .await;
}

async fn answer(
    State((flow, path)): State<(Arc<Flow>, Arc<String>)>,
    uri: Uri,
) -> (StatusCode, Html<&'static str>) {
    if uri.path() != path.as_str() {
        return (StatusCode::NOT_FOUND, Html("Not found"));
    }
    let parameters: Vec<(String, String)> =
        url::form_urlencoded::parse(uri.query().unwrap_or("").as_bytes())
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
    if parameters.is_empty() {
        // The implicit grant returns in the fragment, which only the browser sees.
        return (StatusCode::OK, Html(WAITING_PAGE));
    }
    let state = parameters
        .iter()
        .find(|(k, _)| k == "state")
        .map(|(_, v)| v.as_str());
    if state != Some(flow.state.as_str()) {
        return (StatusCode::BAD_REQUEST, Html(FOREIGN_PAGE));
    }
    flow.set_returned(parameters);
    let _ = flow.stop.send(true);
    (StatusCode::OK, Html(DONE_PAGE))
}

/// Opens an address in the system browser. `NEXO_NO_BROWSER` turns it off for tests.
pub fn open_browser(address: &str) -> bool {
    if std::env::var_os("NEXO_NO_BROWSER").is_some() {
        return false;
    }
    let spawned = if cfg!(windows) {
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", address])
            .spawn()
    } else if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(address).spawn()
    } else {
        std::process::Command::new("xdg-open").arg(address).spawn()
    };
    spawned.is_ok()
}
