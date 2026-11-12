//! WebSocket connections, and the socket every protocol over WebSocket opens.
use super::*;

impl Task {
    pub(super) fn fail(&self, message: String) {
        self.events.emit("error", json!(message));
        self.events.set("error");
    }
    /// Opens a WebSocket to the address the egress policy approved.
    pub(super) async fn open_socket(&self, url: &Url, protocols: &[String]) -> Result<Socket> {
        self.open_socket_with(url, protocols, &[]).await
    }
    /// Opens a WebSocket with headers besides the connection's own, such as a session cookie.
    pub(super) async fn open_socket_with(
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

    pub(super) async fn websocket(mut self) {
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
}
