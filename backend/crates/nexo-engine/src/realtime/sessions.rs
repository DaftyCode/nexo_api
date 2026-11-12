//! Sending to, reading and closing the open connections.
use super::*;

impl Realtime {
    pub fn send(&self, payload: &Value) -> Result<Value> {
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let session = sessions
            .get(payload["id"].as_str().unwrap_or_default())
            .ok_or_else(|| invalid("Connection not found"))?;
        if session.events.state() != "connected" {
            return Err(invalid("Connection is not open"));
        }
        let message = match &payload["message"] {
            Value::String(text) => text.clone(),
            Value::Null => String::new(),
            other => other.to_string(),
        };
        let qos = qos(&payload["qos"]);
        let command = match session.protocol.as_str() {
            "websocket" => Command::Text(message),
            "kafka" => Command::Kafka(kafka_command(payload, &message)?),
            "graphql-subscription" => {
                return Err(invalid(
                    "A subscription only receives; change the query and connect again",
                ));
            }
            "mqtt" => {
                let topic = payload["topic"]
                    .as_str()
                    .filter(|t| !t.is_empty())
                    .ok_or_else(|| invalid("Enter an MQTT topic"))?
                    .to_string();
                match payload["action"].as_str() {
                    Some("subscribe") => Command::Subscribe { topic, qos },
                    Some("unsubscribe") => Command::Unsubscribe(topic),
                    _ => Command::Publish {
                        topic,
                        message,
                        qos,
                        retain: payload["retain"] == true,
                    },
                }
            }
            _ => Command::Emit {
                event: payload["event"]
                    .as_str()
                    .filter(|e| !e.is_empty())
                    .unwrap_or("message")
                    .to_string(),
                value: serde_json::from_str(&message).unwrap_or(Value::String(message)),
            },
        };
        session
            .commands
            .send(command)
            .map_err(|_| invalid("Connection is not open"))?;
        Ok(json!({"sent": true}))
    }
    pub fn poll(&self, payload: &Value) -> Result<Value> {
        let id = payload["id"].as_str().unwrap_or_default();
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let session = sessions
            .get(id)
            .ok_or_else(|| invalid("Connection not found"))?;
        let after = payload["after"].as_u64().unwrap_or(0);
        let log = session.events.0.lock().unwrap_or_else(|e| e.into_inner());
        let events: Vec<Value> = log
            .events
            .iter()
            .filter(|event| event["sequence"].as_u64().unwrap_or(0) > after)
            .cloned()
            .collect();
        Ok(json!({"id": id, "state": log.state, "events": events}))
    }
    pub fn list(&self) -> Value {
        self.sweep();
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        Value::Array(
            sessions
                .iter()
                .map(|(id, s)| json!({"id": id, "protocol": s.protocol, "url": s.url, "state": s.events.state()}))
                .collect(),
        )
    }
    pub fn disconnect(&self, payload: &Value) -> Result<Value> {
        let session = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(payload["id"].as_str().unwrap_or_default())
            .ok_or_else(|| invalid("Connection not found"))?;
        session.stop.cancel();
        Ok(json!({"closed": true}))
    }
    pub fn close(&self) {
        for (_, session) in self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
        {
            session.stop.cancel();
        }
    }
}
