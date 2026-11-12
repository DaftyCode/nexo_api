//! Engine.IO transports under Socket.IO: HTTP long polling and the upgrade to WebSocket.
use super::*;

/// The Engine.IO endpoint of a Socket.IO URL: its `path` (`/socket.io/` by default) with
/// `EIO=4`, without the namespace, which travels in the packets.
pub(super) fn socketio_url(url: &Url, payload: &Value) -> Url {
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
pub(super) struct Polling {
    pub(super) transport: Arc<crate::transport::Transport>,
    pub(super) url: Url,
    pub(super) sid: String,
    pub(super) upgrades: Vec<String>,
    pub(super) headers: Vec<(String, String)>,
    pub(super) jar: crate::transport::CookieJar,
    /// Packets that came with the handshake.
    pub(super) buffered: Vec<crate::socketio::Frame>,
}
impl Polling {
    pub(super) async fn open(task: &Task, base: &Url) -> Result<Self> {
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
    pub(super) fn address(&self) -> String {
        let mut url = self.url.clone();
        if !self.sid.is_empty() {
            url.query_pairs_mut().append_pair("sid", &self.sid);
        }
        // As the official client does, so no cache answers a poll.
        url.query_pairs_mut()
            .append_pair("t", &uuid::Uuid::new_v4().simple().to_string()[..8]);
        url.to_string()
    }
    pub(super) fn header(&self, extra: &[(&str, &str)]) -> Value {
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
    pub(super) async fn get(&self) -> Result<Vec<crate::socketio::Frame>> {
        let answer = self
            .transport
            .request(
                &json!({"method": "GET", "url": self.address(), "header": self.header(&[])}),
                &[],
            )
            .await?;
        Ok(crate::socketio::decode_payload(&Self::body(&answer)?))
    }
    pub(super) async fn post(&self, frames: &[crate::socketio::Frame]) -> Result<()> {
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
    pub(super) fn body(answer: &Value) -> Result<String> {
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
    pub(super) fn cookie(&self, url: &Url) -> Option<String> {
        let jar = self.jar.lock().unwrap_or_else(|e| e.into_inner());
        let cookie = jar
            .get_request_values(url)
            .map(|(name, value)| format!("{name}={value}"))
            .collect::<Vec<_>>()
            .join("; ");
        (!cookie.is_empty()).then_some(cookie)
    }
    /// Polls in the background, one request at a time, until the session ends.
    pub(super) fn start(self) -> PollingLink {
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
pub(super) struct PollingLink {
    pub(super) session: Arc<Polling>,
    pub(super) receiver: mpsc::Receiver<Result<Vec<crate::socketio::Frame>>>,
    pub(super) task: tokio::task::JoinHandle<()>,
    pub(super) pending: VecDeque<crate::socketio::Frame>,
}
impl Drop for PollingLink {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// The transport a Socket.IO connection uses.
pub(super) enum SocketIoLink {
    Socket(Box<Socket>),
    Polling(Box<PollingLink>),
}
impl SocketIoLink {
    pub(super) fn name(&self) -> &'static str {
        match self {
            Self::Socket(_) => "websocket",
            Self::Polling(_) => "polling",
        }
    }
    pub(super) async fn send(
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
    pub(super) async fn next(
        &mut self,
    ) -> Option<std::result::Result<crate::socketio::Frame, String>> {
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
    pub(super) async fn close(&mut self, disconnect: &str) {
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
