//! The dashboard of a server (DB-22): the panels its driver offers (`db.dashboards`), and a
//! reading of one panel (`db.dashboard.read`). A panel only reads: its query is one
//! statement classified as a read, or it is refused, whoever asks. Readings come every few
//! seconds, so they are not recorded in the history nor in the transaction's journal, and a
//! cursor left open is closed.
use super::{redacted, sessions::session_name};
use crate::{
    Application,
    payloads::{DbDashboardReadPayload, DbSessionPayload},
    ports::{DataSources, StatementRequest},
};
use nexo_domain::{
    Error, Result,
    sql::{Dialect, StatementKind, classify, split},
};
use serde_json::{Value, json};

/// Rows a reading keeps: a panel draws a series per row.
const ROWS: u32 = 100;

impl Application {
    pub(super) async fn dashboards(
        &self,
        sources: &dyn DataSources,
        payload: DbSessionPayload,
    ) -> Result<Value> {
        let name = session_name(&payload.session)?;
        let session = self.sql_sessions.get(name)?;
        let answer = sources.dashboards(name, json!({"connection": name})).await;
        redacted(answer, &session)
    }

    pub(super) async fn read_dashboard(
        &self,
        sources: &dyn DataSources,
        payload: DbDashboardReadPayload,
    ) -> Result<Value> {
        let session = self.sql_sessions.get(session_name(&payload.session)?)?;
        let dialect = Dialect::parse(&session.driver);
        let statements = split(&payload.sql, dialect);
        let [statement] = statements.as_slice() else {
            return Err(Error::Validation(
                "A panel runs one query: write a single statement".into(),
            ));
        };
        if classify(&statement.text, dialect).kind != StatementKind::Read {
            return Err(Error::Validation(
                "A panel only reads: its query may not change data, structure or the session"
                    .into(),
            ));
        }
        let request = StatementRequest {
            statement: payload.statement,
            sql: payload.sql,
            params: Vec::new(),
            page_rows: Some(ROWS),
            max_rows: Some(u64::from(ROWS)),
            timeout: session.timeout,
        };
        let mut answer = sources.execute(&payload.session, request).await;
        if let Ok(value) = &mut answer
            && let Some(cursor) = value["cursor"].as_str().map(str::to_owned)
        {
            let _ = sources.close(&payload.session, &cursor).await;
            value["cursor"] = Value::Null;
        }
        redacted(answer, &session)
    }
}
