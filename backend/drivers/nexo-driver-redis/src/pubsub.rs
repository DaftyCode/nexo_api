//! Channels and patterns followed on a connection of their own (RESP3, whose pushes carry
//! the messages), kept here until the realtime panel reads them by polling: the last
//! [`KEPT`] of each subscription, never more.
use crate::{
    connection::{Conn, Target, failure},
    reply::{cell, raw, text},
};
use nexo_driver_sdk::{
    DriverError, Result,
    keyvalue::{Event, Events},
};
use redis::{PushKind, Value};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::task::JoinHandle;

/// Messages kept of a subscription before the oldest go.
pub(crate) const KEPT: usize = 1000;
/// Subscriptions a connection may have open.
pub(crate) const MAX: usize = 8;

#[derive(Default)]
struct Log {
    sequence: u64,
    state: String,
    events: VecDeque<Event>,
}

pub(crate) struct Subscription {
    log: Arc<Mutex<Log>>,
    task: JoinHandle<()>,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

fn record(log: &Mutex<Log>, kind: &str, channel: String, pattern: Option<String>, payload: &Value) {
    let mut log = log.lock().unwrap();
    log.sequence += 1;
    let event = Event {
        sequence: log.sequence,
        kind: kind.into(),
        channel,
        pattern,
        payload: cell(&raw(payload)),
        time: now(),
    };
    log.events.push_back(event);
    while log.events.len() > KEPT {
        log.events.pop_front();
    }
}

/// Opens a subscription to `channels` and `patterns`.
pub(crate) async fn subscribe(
    target: &Target,
    channels: Vec<String>,
    patterns: Vec<String>,
) -> Result<Subscription> {
    if channels.is_empty() && patterns.is_empty() {
        return Err(DriverError::invalid(
            "Name a channel or a pattern to follow",
        ));
    }
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    let connection = target.open(Some(sender)).await?;
    match connection.clone() {
        Conn::Single(mut single) => {
            for channel in &channels {
                single.subscribe(channel).await.map_err(failure)?;
            }
            for pattern in &patterns {
                single.psubscribe(pattern).await.map_err(failure)?;
            }
        }
        Conn::Cluster(mut cluster) => {
            for channel in &channels {
                cluster.subscribe(channel).await.map_err(failure)?;
            }
            for pattern in &patterns {
                cluster.psubscribe(pattern).await.map_err(failure)?;
            }
        }
    }
    let log = Arc::new(Mutex::new(Log {
        state: "connected".into(),
        ..Log::default()
    }));
    let kept = log.clone();
    let task = tokio::spawn(async move {
        // The connection lives as long as the subscription.
        let _connection = connection;
        while let Some(push) = receiver.recv().await {
            let data = push.data;
            match push.kind {
                PushKind::Message | PushKind::SMessage if data.len() >= 2 => {
                    let channel = text(&data[0]).unwrap_or_default();
                    record(&kept, "message", channel, None, &data[1]);
                }
                PushKind::PMessage if data.len() >= 3 => {
                    let channel = text(&data[1]).unwrap_or_default();
                    record(&kept, "pmessage", channel, text(&data[0]), &data[2]);
                }
                PushKind::Disconnection => {
                    kept.lock().unwrap().state = "error".into();
                    break;
                }
                _ => {}
            }
        }
        let mut log = kept.lock().unwrap();
        if log.state == "connected" {
            log.state = "closed".into();
        }
    });
    Ok(Subscription { log, task })
}

impl Subscription {
    /// The messages after `after`, and the state.
    pub(crate) fn events(&self, after: u64) -> Events {
        let log = self.log.lock().unwrap();
        Events {
            state: log.state.clone(),
            events: log
                .events
                .iter()
                .filter(|event| event.sequence > after)
                .cloned()
                .collect(),
        }
    }
}
