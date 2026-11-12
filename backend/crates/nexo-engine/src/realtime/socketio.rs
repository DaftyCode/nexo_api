//! Socket.IO connections over long polling or WebSocket.
use super::*;

impl Task {
    /// Socket.IO v4 over Engine.IO v4. `transports` chooses how: `websocket`, `polling`
    /// (HTTP long polling, for networks whose proxies block WebSocket) or, by default, both as
    /// the official client does: long polling first, upgraded to WebSocket when the server
    /// offers it. Binary events arrive and are sent as `{"$binary": base64}`.
    pub(super) async fn socketio(mut self) {
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
    pub(super) fn socketio_packet(&self, packet: crate::socketio::Packet, namespace: &str) {
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
    pub(super) async fn socketio_link(&self, mode: &str) -> Result<(SocketIoLink, bool)> {
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
    pub(super) async fn socketio_socket(
        &self,
        base: &Url,
        session: Option<&Polling>,
    ) -> Result<Socket> {
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
}
