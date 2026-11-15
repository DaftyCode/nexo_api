//! What SQL Server says besides results, which tiberius writes to its log instead of
//! returning: the messages (`PRINT`, `RAISERROR` with severity 10 or less) and the database a
//! session changes to (`USE`). This catches those log events by the task that read them, so
//! each session gets its own.
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};
use tokio::task::Id;
use tracing::{
    Event, Metadata, Subscriber,
    field::{Field, Visit},
    span,
};

/// Where tiberius writes an info message (`TokenStream::get_info`) and an environment change
/// (`get_env_change`). tiberius is pinned to one version in `Cargo.toml`: the driver's tests
/// fail if these ever move.
const TARGET: &str = "tiberius::tds::stream::token";
const MESSAGE_LINE: u32 = 405;
const CHANGE_LINE: u32 = 398;
const DATABASE_CHANGE: &str = "Database change from '";

/// What a session heard.
#[derive(Default)]
struct Heard {
    messages: Vec<String>,
    database: Option<String>,
}

/// What each task (a session) heard.
fn caught() -> &'static Mutex<HashMap<Id, Heard>> {
    static CAUGHT: OnceLock<Mutex<HashMap<Id, Heard>>> = OnceLock::new();
    CAUGHT.get_or_init(Mutex::default)
}

struct Catcher;

struct Message(Option<String>);
impl Visit for Message {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.0 = Some(format!("{value:?}"));
        }
    }
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.0 = Some(value.to_owned());
        }
    }
}

fn wanted(metadata: &Metadata<'_>) -> bool {
    metadata.target() == TARGET && matches!(metadata.line(), Some(MESSAGE_LINE | CHANGE_LINE))
}

impl Subscriber for Catcher {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        wanted(metadata)
    }
    fn new_span(&self, _: &span::Attributes<'_>) -> span::Id {
        span::Id::from_u64(1)
    }
    fn record(&self, _: &span::Id, _: &span::Record<'_>) {}
    fn record_follows_from(&self, _: &span::Id, _: &span::Id) {}
    fn event(&self, event: &Event<'_>) {
        if !wanted(event.metadata()) {
            return;
        }
        let Some(task) = tokio::task::try_id() else {
            return;
        };
        let mut message = Message(None);
        event.record(&mut message);
        let Some(text) = message.0 else {
            return;
        };
        let mut caught = caught().lock().unwrap();
        let Some(heard) = caught.get_mut(&task) else {
            return;
        };
        if event.metadata().line() == Some(MESSAGE_LINE) {
            heard.messages.push(text);
        } else if let Some(change) = text.strip_prefix(DATABASE_CHANGE) {
            // "Database change from 'old' to 'new'": the name is between the last quotes.
            if let Some((_, name)) = change.rsplit_once("' to '") {
                heard.database = Some(name.strip_suffix('\'').unwrap_or(name).to_owned());
            }
        }
    }
    fn enter(&self, _: &span::Id) {}
    fn exit(&self, _: &span::Id) {}
}

/// Starts catching messages in this process, once.
pub(crate) fn start() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        let _ = tracing::subscriber::set_global_default(Catcher);
    });
}

/// Catches what the current task (a session) hears, until it stops.
pub(crate) fn listen() {
    if let Some(task) = tokio::task::try_id() {
        caught().lock().unwrap().entry(task).or_default();
    }
}
pub(crate) fn stop() {
    if let Some(task) = tokio::task::try_id() {
        caught().lock().unwrap().remove(&task);
    }
}
/// The messages caught since the last time.
pub(crate) fn take() -> Vec<String> {
    tokio::task::try_id()
        .and_then(|task| {
            caught()
                .lock()
                .unwrap()
                .get_mut(&task)
                .map(|heard| std::mem::take(&mut heard.messages))
        })
        .unwrap_or_default()
}
/// The database the session last changed to, if it changed.
pub(crate) fn database() -> Option<String> {
    let task = tokio::task::try_id()?;
    caught().lock().unwrap().get(&task)?.database.clone()
}
