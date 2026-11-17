//! Searching a session's connection (`db.search`): its objects by name or code, or a value in
//! the data of chosen tables. Searching data may read whole tables, so on a production
//! connection it runs only once confirmed. Nothing found is kept.
use super::{redacted, sessions::session_name};
use crate::{Application, payloads::DbSearchPayload, ports::DataSources};
use nexo_domain::{Error, Result, sql::ConnectionType};
use serde_json::{Value, json};

impl Application {
    pub(super) async fn search_session(
        &self,
        sources: &dyn DataSources,
        payload: DbSearchPayload,
    ) -> Result<Value> {
        let session = self.sql_sessions.get(session_name(&payload.session)?)?;
        let data = payload.mode.as_deref() == Some("data");
        if data && session.kind == ConnectionType::Production && !payload.confirm.unwrap_or(false) {
            return Err(Error::Validation(format!(
                "The connection {} is for production: confirm the search, as it may read whole tables",
                session.name
            )));
        }
        let request = json!({
            "connection": payload.session,
            "statement": payload.statement,
            "mode": if data { "data" } else { "metadata" },
            "text": payload.text,
            "kinds": payload.kinds.unwrap_or_default(),
            "code": payload.code.unwrap_or(false),
            "schemas": payload.schemas.unwrap_or_default(),
            "max": payload.max,
            "tables": payload.tables.unwrap_or_default(),
            "caseSensitive": payload.case_sensitive.unwrap_or(false),
            "wholeWord": payload.whole_word.unwrap_or(false),
            "columns": payload.columns.unwrap_or_default(),
            "maxRows": payload.max_rows,
        });
        redacted(sources.search(&payload.session, request).await, &session)
    }
}
