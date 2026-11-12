//! MQTT connections over TCP, TLS or WebSocket.
use super::*;

pub(super) fn qos(value: &Value) -> QoS {
    match value
        .as_u64()
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
    {
        Some(1) => QoS::AtLeastOnce,
        Some(2) => QoS::ExactlyOnce,
        _ => QoS::AtMostOnce,
    }
}

impl Task {
    pub(super) async fn mqtt(mut self) {
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
    pub(super) async fn open_mqtt(&self) -> Result<mqtt::Connection> {
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
