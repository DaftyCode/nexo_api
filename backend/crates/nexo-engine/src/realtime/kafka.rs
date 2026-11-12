//! Kafka connections: commands from the client and the session that runs them.
use super::*;

pub(super) enum KafkaCommand {
    Produce(crate::kafka::Outgoing),
    Subscribe {
        topic: String,
        partition: Option<i32>,
        start: crate::kafka::Start,
    },
    Unsubscribe,
    Topics,
}

/// A Kafka `realtime.send`: `produce` by default, or `subscribe`, `unsubscribe`, `topics`.
pub(super) fn kafka_command(payload: &Value, message: &str) -> Result<KafkaCommand> {
    let topic = || {
        payload["topic"]
            .as_str()
            .map(str::trim)
            .filter(|topic| !topic.is_empty())
            .map(String::from)
            .ok_or_else(|| invalid("Enter a Kafka topic"))
    };
    let partition = payload["partition"]
        .as_i64()
        .map(|partition| i32::try_from(partition).map_err(|_| invalid("Enter a valid partition")))
        .transpose()?;
    Ok(match payload["action"].as_str().unwrap_or("produce") {
        "subscribe" => KafkaCommand::Subscribe {
            topic: topic()?,
            partition,
            start: crate::kafka::Start::from_payload(payload)?,
        },
        "unsubscribe" => KafkaCommand::Unsubscribe,
        "topics" => KafkaCommand::Topics,
        "produce" | "publish" => KafkaCommand::Produce(crate::kafka::Outgoing {
            topic: topic()?,
            partition,
            key: payload["key"]
                .as_str()
                .filter(|key| !key.is_empty())
                .map(crate::kafka::bytes_of)
                .transpose()?,
            value: Some(crate::kafka::bytes_of(message)?),
            headers: header_rows(&payload["headers"])
                .into_iter()
                .map(|(name, value)| Ok((name, crate::kafka::bytes_of(&value)?)))
                .collect::<Result<_>>()?,
        }),
        other => return Err(invalid(format!("Unknown Kafka action {other}"))),
    })
}

/// A Kafka connection: commands produce and choose what is read; while a topic is being read,
/// its new messages are fetched between commands.
pub(super) async fn kafka_session(
    settings: crate::kafka::Settings,
    events: Events,
    mut commands: mpsc::UnboundedReceiver<Command>,
    stop: CancellationToken,
) {
    let fail = |message: String| {
        events.emit("error", json!(message));
        events.set("error");
    };
    let mut cluster = tokio::select! {
        _ = stop.cancelled() => return,
        connected = tokio::time::timeout(CONNECT_TIMEOUT * 2, crate::kafka::Cluster::connect(settings)) => match connected {
            Ok(Ok(cluster)) => cluster,
            Ok(Err(error)) => return fail(error.to_string()),
            Err(_) => return fail("Connecting to the cluster timed out".into()),
        },
    };
    events.set("connected");
    events.emit("open", json!("Connected"));
    let topics = |topics: Vec<crate::kafka::Topic>| {
        json!(topics
            .into_iter()
            .map(|topic| json!({"name": topic.name, "partitions": topic.leaders.len(), "internal": topic.internal}))
            .collect::<Vec<_>>())
    };
    match cluster.topics().await {
        Ok(listed) => events.emit("topics", topics(listed)),
        Err(error) => events.emit("error", json!(error.to_string())),
    }
    let mut reading: Option<(String, BTreeMap<i32, i64>)> = None;
    loop {
        tokio::select! {
            biased;
            _ = stop.cancelled() => {
                events.set("closed");
                return;
            }
            command = commands.recv() => {
                let Some(Command::Kafka(command)) = command else {
                    if command.is_none() {
                        return;
                    }
                    continue;
                };
                match command {
                    KafkaCommand::Produce(message) => match cluster.produce(message).await {
                        Ok(written) => events.emit("produced", written),
                        Err(error) => events.emit("error", json!(error.to_string())),
                    },
                    KafkaCommand::Subscribe { topic, partition, start } => {
                        match cluster.positions(&topic, partition, start).await {
                            Ok(positions) => {
                                events.emit("subscribed", json!({"topic": topic, "positions": positions}));
                                reading = Some((topic, positions));
                            }
                            Err(error) => events.emit("error", json!(error.to_string())),
                        }
                    }
                    KafkaCommand::Unsubscribe => {
                        if let Some((topic, _)) = reading.take() {
                            events.emit("unsubscribed", json!({"topic": topic}));
                        }
                    }
                    KafkaCommand::Topics => match cluster.topics().await {
                        Ok(listed) => events.emit("topics", topics(listed)),
                        Err(error) => events.emit("error", json!(error.to_string())),
                    },
                }
            }
            // Waits up to half a second for new messages, then lets commands in again.
            _ = std::future::ready(()), if reading.is_some() => {
                let (topic, positions) = reading.as_mut().expect("reading");
                match cluster.fetch(topic, positions).await {
                    Ok(messages) => {
                        for message in messages {
                            events.emit("message", message);
                        }
                    }
                    Err(error) => {
                        events.emit("error", json!(error.to_string()));
                        reading = None;
                    }
                }
            }
        }
    }
}
