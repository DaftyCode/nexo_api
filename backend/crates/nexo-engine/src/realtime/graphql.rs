//! GraphQL subscriptions over WebSocket (`graphql-ws`, `subscriptions-transport-ws`) or
//! server-sent events.
use super::*;

impl Task {
    /// A GraphQL subscription over WebSocket, with `graphql-transport-ws` or the legacy
    /// `graphql-ws`. Each result is a `next` event; closing ends the subscription first.
    pub(super) async fn graphql(mut self) {
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
    pub(super) async fn graphql_sse(mut self, operation: crate::graphql_ws::Operation) {
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
}
