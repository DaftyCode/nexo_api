//! The key-value stores (DB-35: Redis and Valkey) with the rules of every connection: keys
//! are read on any one; a read-only connection changes nothing, not even from the console
//! (whose reads are a closed list); production asks before every change; a dangerous
//! command (`FLUSHDB`, `CONFIG SET`…) is confirmed by typing its name. Subscriptions are
//! sessions of their own, read and closed from the realtime panel by their id.
use super::{Application, redacted, sessions::session_name};
use crate::{
    operations::Operation,
    payloads::{
        DbKvCommandPayload, DbKvGetPayload, DbKvScanPayload, DbKvSubscribePayload, DbKvWritePayload,
    },
    ports::DataSources,
};
use nexo_domain::{
    Error, Result,
    keyvalue::{classify_command, split_command},
};
use serde_json::{Map, Value, json};
use std::sync::atomic::{AtomicU64, Ordering};

/// The start of the id of a subscription in the realtime panel: `redis-sub-<n>`, also the
/// name of its session.
pub(crate) const SUBSCRIPTION_PREFIX: &str = "redis-sub-";
static SUBSCRIPTIONS: AtomicU64 = AtomicU64::new(0);

fn refused(message: impl Into<String>) -> Error {
    Error::Validation(message.into())
}

/// Bytes as the driver takes them: text, or `binary`.
fn argument(bytes: Vec<u8>) -> Value {
    match String::from_utf8(bytes) {
        Ok(text) => Value::String(text),
        Err(error) => {
            use base64::Engine;
            let encoded = base64::engine::general_purpose::STANDARD.encode(error.as_bytes());
            json!({"$t": "binary", "v": encoded})
        }
    }
}

/// An argument as text, to classify the command.
fn word(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Object(typed) => typed
            .get("v")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        other => other.to_string(),
    }
}

impl Application {
    pub(super) async fn kv_scan(
        &self,
        sources: &dyn DataSources,
        p: DbKvScanPayload,
    ) -> Result<Value> {
        let session = self.sql_sessions.get(session_name(&p.session)?)?;
        let request =
            json!({"pattern": p.pattern, "type": p.kind, "cursor": p.cursor, "count": p.count});
        redacted(
            sources
                .extension(&p.session, "kv.scan", without_nulls(request))
                .await,
            &session,
        )
    }

    pub(super) async fn kv_get(
        &self,
        sources: &dyn DataSources,
        p: DbKvGetPayload,
    ) -> Result<Value> {
        let session = self.sql_sessions.get(session_name(&p.session)?)?;
        let request = json!({"key": p.key, "cursor": p.cursor, "count": p.count});
        redacted(
            sources
                .extension(&p.session, "kv.get", without_nulls(request))
                .await,
            &session,
        )
    }

    pub(super) async fn kv_write(
        &self,
        sources: &dyn DataSources,
        p: DbKvWritePayload,
    ) -> Result<Value> {
        let session = self.sql_sessions.get(session_name(&p.session)?)?;
        if session.read_only {
            return Err(refused(format!(
                "The connection {} is read-only: Nexo changes no key",
                session.name
            )));
        }
        let confirmed = p.confirm.unwrap_or(false);
        if p.action == "delete" && !confirmed {
            return Err(refused("Confirm that the key is deleted"));
        }
        if session.rules.confirm_writes && !confirmed {
            return Err(refused(format!(
                "The connection {} asks to confirm each change: confirm it first",
                session.name
            )));
        }
        let fields: Vec<Value> = p.fields.unwrap_or_default();
        let request = json!({
            "key": p.key, "action": p.action, "type": p.kind, "value": p.value,
            "field": p.field, "score": p.score, "index": p.index, "fields": fields,
            "to": p.to, "ttlMs": p.ttl_ms,
        });
        redacted(
            sources
                .extension(&p.session, "kv.write", without_nulls(request))
                .await,
            &session,
        )
    }

    pub(super) async fn kv_command(
        &self,
        sources: &dyn DataSources,
        p: DbKvCommandPayload,
    ) -> Result<Value> {
        let session = self.sql_sessions.get(session_name(&p.session)?)?;
        let args: Vec<Value> = match (p.args, p.line) {
            (Some(args), _) if !args.is_empty() => args,
            (_, Some(line)) => split_command(&line)
                .ok_or_else(|| refused("A quote of the command is not closed"))?
                .into_iter()
                .map(argument)
                .collect(),
            _ => Vec::new(),
        };
        if args.is_empty() {
            return Err(refused("Write a command"));
        }
        let class = classify_command(&args.iter().map(word).collect::<Vec<_>>());
        if let Some(why) = class.refused {
            return Err(refused(why));
        }
        if session.read_only && class.writes() {
            return Err(refused(format!(
                "The connection {} is read-only: Nexo runs only commands that read ({} is not one)",
                session.name, class.name
            )));
        }
        let typed = p.confirm_name.as_deref().map(str::trim).unwrap_or_default();
        if class.dangerous && !typed.eq_ignore_ascii_case(&class.name) {
            return Err(refused(format!("Type {} to confirm it", class.name)));
        }
        if session.rules.confirm_writes && class.writes() && !p.confirm.unwrap_or(false) {
            return Err(refused(format!(
                "The connection {} asks to confirm each change: confirm {} first",
                session.name, class.name
            )));
        }
        let answer = sources
            .extension(&p.session, "kv.command", json!({"args": args}))
            .await;
        redacted(answer, &session)
    }

    /// Opens a session of its own on the connection and follows the channels on it.
    pub(super) async fn kv_subscribe(
        &self,
        sources: &dyn DataSources,
        p: DbKvSubscribePayload,
    ) -> Result<Value> {
        let session = format!(
            "{SUBSCRIPTION_PREFIX}{}",
            SUBSCRIPTIONS.fetch_add(1, Ordering::Relaxed) + 1
        );
        let connect = json!({
            "workspace": p.workspace, "connectionId": p.connection_id, "session": session,
            "variables": p.variables.unwrap_or_default(),
        });
        Box::pin(self.datasource(Operation::DbConnect, connect)).await?;
        let (channels, patterns) = (
            p.channels.unwrap_or_default(),
            p.patterns.unwrap_or_default(),
        );
        let followed = channels
            .iter()
            .chain(&patterns)
            .cloned()
            .collect::<Vec<_>>()
            .join(", ");
        let request = json!({"channels": channels, "patterns": patterns});
        let opened = match sources.extension(&session, "kv.subscribe", request).await {
            Ok(opened) => opened,
            Err(error) => {
                self.sql_sessions.remove(&session);
                let _ = sources.disconnect(&session).await;
                return Err(error);
            }
        };
        // A subscription is never closed for being idle: it waits for messages.
        sources.hold(&session, true).await?;
        let subscription = opened["subscription"].as_str().unwrap_or_default();
        let id = format!("{session}.{subscription}");
        let name = self
            .sql_sessions
            .get(&session)
            .map(|open| open.name.clone())
            .unwrap_or_default();
        self.sql_sessions.follow(&id, format!("{name}: {followed}"));
        Ok(json!({"id": id, "state": "connected"}))
    }

    /// The realtime operations on a subscription, by its id; `None` for the others.
    pub(crate) async fn kv_realtime(
        &self,
        operation: Operation,
        payload: &Map<String, Value>,
    ) -> Result<Option<Value>> {
        let id = payload
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let Some((session, subscription)) = id
            .strip_prefix(SUBSCRIPTION_PREFIX)
            .and_then(|_| id.rsplit_once('.'))
        else {
            return Ok(None);
        };
        let Some(sources) = self.datasources.as_deref() else {
            return Ok(None);
        };
        let open = self.sql_sessions.get(session)?;
        let answer = match operation {
            Operation::RealtimePoll => {
                let after = payload.get("after").and_then(Value::as_u64).unwrap_or(0);
                let request = json!({"subscription": subscription, "after": after});
                let read = sources.extension(session, "kv.events", request).await?;
                let events: Vec<Value> = read["events"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|event| {
                        json!({
                            "sequence": event["sequence"], "type": event["type"],
                            "time": event["time"],
                            "data": {"channel": event["channel"], "pattern": event["pattern"], "payload": event["payload"]},
                        })
                    })
                    .collect();
                json!({"id": id, "state": read["state"], "events": events})
            }
            Operation::RealtimeClose => {
                let _ = sources
                    .extension(
                        session,
                        "kv.unsubscribe",
                        json!({"subscription": subscription}),
                    )
                    .await;
                self.sql_sessions.remove(session);
                self.sql_sessions.unfollow(id);
                let _ = sources.disconnect(session).await;
                json!({"closed": true})
            }
            Operation::RealtimeSend => {
                return Err(refused(
                    "A subscription only receives: publish from the console with PUBLISH",
                ));
            }
            _ => return Ok(None),
        };
        redacted(Ok(answer), &open).map(Some)
    }
}

impl Application {
    /// The subscriptions open, as the realtime panel lists its connections.
    pub(crate) fn kv_subscriptions(&self) -> Vec<Value> {
        self.sql_sessions
            .followed()
            .into_iter()
            .map(|(id, what)| json!({"id": id, "protocol": "redis", "url": what, "state": "connected"}))
            .collect()
    }
}

/// Leaves out the fields a payload did not have, so the driver applies its defaults.
fn without_nulls(mut value: Value) -> Value {
    if let Value::Object(fields) = &mut value {
        fields.retain(|_, field| !field.is_null());
    }
    value
}
