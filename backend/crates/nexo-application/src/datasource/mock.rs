//! Test data (DB-27): a batch of rows made by the generators of `nexo_domain::mock`, shown
//! before anything is written or written into the table with the import of DB-17, row by row
//! so a row the database refuses is counted and the others still go in. Never into a
//! read-only connection, nor into one whose type confirms each change (production).
use super::sessions::session_name;
use crate::{Application, payloads::DbMockRowsPayload, ports::DataSources};
use nexo_domain::{
    Error, Result,
    mock::{self, MAX_BATCH, MAX_ROWS, MockColumn},
};
use serde_json::{Value, json};

impl Application {
    pub(super) async fn mock_rows(
        &self,
        sources: &dyn DataSources,
        payload: DbMockRowsPayload,
    ) -> Result<Value> {
        let session = self.sql_sessions.get(session_name(&payload.session)?)?;
        if session.read_only || session.rules.confirm_writes {
            return Err(Error::Validation(format!(
                "The connection {} does not take test data: it is read-only or asks to confirm each change",
                session.name
            )));
        }
        let columns: Vec<MockColumn> = payload
            .columns
            .into_iter()
            .map(serde_json::from_value)
            .collect::<std::result::Result<_, _>>()
            .map_err(|error| Error::Validation(format!("The test data is not valid: {error}")))?;
        mock::validate(&columns)?;
        if payload.first >= MAX_ROWS {
            return Err(Error::Validation(format!(
                "A run makes {MAX_ROWS} rows at most"
            )));
        }
        let count = u64::from(payload.count.min(MAX_BATCH)).min(MAX_ROWS - payload.first) as u32;
        let rows = mock::rows(&columns, payload.seed, payload.first, count);
        let names: Vec<&str> = columns.iter().map(|column| column.name.as_str()).collect();
        if !payload.write.unwrap_or(false) {
            return Ok(json!({"columns": names, "rows": rows}));
        }
        let request = json!({
            "connection": payload.session,
            "schema": payload.schema,
            "table": payload.table,
            "columns": names,
            "rows": rows,
            "mode": "insert",
            "key": [],
            "stopOnError": false,
            "first": payload.first + 1,
        });
        self.write_batch(sources, &payload.session, &session, request)
            .await
    }
}
