//! The history of the statements run on the database connections: what ran, when, for how
//! long and what it changed or why it failed; never its results.
use super::sessions::Session;
use crate::Application;
use nexo_domain::{Document, DocumentId, DocumentKind};
use serde_json::{Value, json};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The longest statement kept whole in the history.
const KEPT: usize = 64 * 1024;
/// The name a statement is listed by: its first line, shortened.
const NAME: usize = 120;

fn cut(text: &str, limit: usize) -> &str {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

impl Application {
    /// Records a statement that ran (or failed) on a session. Recording never fails the
    /// statement: a history that cannot be written is only logged.
    pub(super) async fn record_statement(
        &self,
        session: &Session,
        sql: &str,
        took: Duration,
        outcome: Result<&Value, String>,
    ) {
        let first_line = sql.trim().lines().next().unwrap_or_default();
        let mut name = cut(first_line, NAME).to_owned();
        if name.len() < sql.trim().len() {
            name.push('…');
        }
        let started = SystemTime::now()
            .checked_sub(took)
            .unwrap_or(SystemTime::now())
            .duration_since(UNIX_EPOCH)
            .map_or(0, |time| time.as_millis() as u64);
        let mut value = json!({
            "connectionId": session.connection.as_str(),
            "connection": session.name,
            "sql": cut(sql, KEPT),
            "truncated": sql.len() > KEPT,
            "startedAt": started,
            "durationMs": took.as_millis() as u64,
        });
        match outcome {
            Ok(result) => {
                value["rows"] = json!(result["rows"].as_array().map_or(0, Vec::len));
                value["affected"] = result["affected"].clone();
                value["more"] = json!(!result["cursor"].is_null());
            }
            Err(error) => value["error"] = json!(error),
        }
        let Ok(id) = DocumentId::parse(uuid::Uuid::new_v4().to_string()) else {
            return;
        };
        let document = Document {
            id,
            workspace_id: session.workspace.clone(),
            kind: DocumentKind::SqlHistory,
            name: if name.is_empty() {
                "(empty)".into()
            } else {
                name
            },
            revision: 0,
            updated_at: 0,
            value,
        };
        if let Err(error) = self.save_document(document).await {
            tracing::warn!(%error, "A statement could not be recorded in the history");
        }
    }
}
