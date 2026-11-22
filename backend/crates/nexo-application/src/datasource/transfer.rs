//! Data into a table (DB-17): a batch of rows from a file (`db.import`), the `CREATE TABLE`
//! of a target engine for columns read elsewhere (`db.convert`), and a page of a query copied
//! from one connection to another (`db.copy`), from driver to driver, never through the
//! interface. The target follows the rules of every change: never a read-only connection,
//! and on production only once confirmed. Nothing of it can be undone.
use super::{redacted, rules, sessions::Session, sessions::session_name};
use crate::{
    Application,
    payloads::{DbConvertPayload, DbCopyPayload, DbImportPayload},
    ports::{DataSources, StatementRequest},
};
use nexo_domain::{
    Error, Result,
    sql::{Dialect, SourceColumn, StatementKind, create_table},
};
use serde_json::{Value, json};
use std::sync::Arc;

/// Rows read from the source at a time, and so written in one batch.
const PAGE_ROWS: u32 = 1_000;

fn refused(message: impl Into<String>) -> Error {
    Error::Validation(message.into())
}

/// The rules of a target: it must take changes, and on production they are confirmed.
fn writable(session: &Session, confirm: Option<bool>) -> Result<()> {
    if session.read_only {
        return Err(refused(format!(
            "The connection {} is read-only: nothing can be imported into it",
            session.name
        )));
    }
    if session.rules.confirm_writes && !confirm.unwrap_or(false) {
        return Err(refused(format!(
            "The connection {} asks to confirm each change: confirm the import before it writes",
            session.name
        )));
    }
    Ok(())
}

impl Application {
    /// Writes a batch with the target's driver, and logs it in its transaction.
    pub(in crate::datasource) async fn write_batch(
        &self,
        sources: &dyn DataSources,
        name: &str,
        session: &Arc<Session>,
        request: Value,
    ) -> Result<Value> {
        let table = request["table"].as_str().unwrap_or_default().to_owned();
        let rows = request["rows"].as_array().map_or(0, Vec::len);
        let started = std::time::Instant::now();
        let answer = redacted(sources.import(name, request).await, session)?;
        let written =
            answer["inserted"].as_u64().unwrap_or(0) + answer["upserted"].as_u64().unwrap_or(0);
        session.journal.lock().unwrap().statement(
            &format!("-- {rows} rows imported into {table}"),
            started.elapsed(),
            Some(written),
            written > 0,
        );
        self.hold_open(sources, name, session).await;
        Ok(answer)
    }

    pub(super) async fn import_rows(
        &self,
        sources: &dyn DataSources,
        payload: DbImportPayload,
    ) -> Result<Value> {
        let session = self.sql_sessions.get(session_name(&payload.session)?)?;
        writable(&session, payload.confirm)?;
        let request = json!({
            "connection": payload.session,
            "schema": payload.schema,
            "table": payload.table,
            "columns": payload.columns,
            "rows": payload.rows,
            "mode": payload.mode.unwrap_or_else(|| "insert".into()),
            "key": payload.key.unwrap_or_default(),
            "stopOnError": payload.stop_on_error.unwrap_or(false),
            "first": payload.first.unwrap_or(1),
        });
        self.write_batch(sources, &payload.session, &session, request)
            .await
    }

    /// The `CREATE TABLE` of columns in the session's engine; nothing runs.
    pub(super) fn convert_columns(&self, payload: DbConvertPayload) -> Result<Value> {
        let session = self.sql_sessions.get(session_name(&payload.session)?)?;
        let columns: Vec<SourceColumn> = payload
            .columns
            .iter()
            .map(|column| SourceColumn {
                name: column["name"].as_str().unwrap_or_default().to_owned(),
                kind: column["kind"].as_str().unwrap_or("text").to_owned(),
                type_name: column["typeName"].as_str().unwrap_or_default().to_owned(),
                nullable: column["nullable"].as_bool(),
            })
            .collect();
        if columns.iter().any(|column| column.name.trim().is_empty()) {
            return Err(refused("Every column needs a name"));
        }
        let from = Dialect::parse(payload.source_driver.as_deref().unwrap_or(""));
        let to = payload.target_driver.as_deref().unwrap_or(&session.driver);
        let (sql, converted) = create_table(
            Dialect::parse(to),
            payload.schema.as_deref(),
            &payload.table,
            &columns,
            from,
        );
        let converted: Vec<Value> = converted
            .into_iter()
            .map(|column| {
                json!({"name": column.name, "from": column.from, "type": column.sql_type, "asText": column.as_text})
            })
            .collect();
        Ok(json!({"sql": sql, "columns": converted}))
    }

    /// A page of a query read from the source and written into the target. The first call
    /// runs the query; the next ones read on with its cursor.
    pub(super) async fn copy_page(
        &self,
        sources: &dyn DataSources,
        payload: DbCopyPayload,
    ) -> Result<Value> {
        let source = self.sql_sessions.get(session_name(&payload.source)?)?;
        let target = self.sql_sessions.get(session_name(&payload.target)?)?;
        writable(&target, payload.confirm)?;
        let page_rows = payload.page_rows.unwrap_or(PAGE_ROWS).clamp(1, 10_000);
        let (columns, rows, cursor) = match (&payload.sql, &payload.cursor) {
            (Some(sql), None) => {
                let kind = rules::classify_all(sql, Dialect::parse(&source.driver)).kind;
                if kind != StatementKind::Read {
                    return Err(refused("Only what a query reads can be copied"));
                }
                let request = StatementRequest {
                    statement: format!("copy-{}", payload.target),
                    sql: sql.clone(),
                    params: Vec::new(),
                    page_rows: Some(page_rows),
                    max_rows: None,
                    timeout: source.timeout,
                };
                let page = redacted(sources.execute(&payload.source, request).await, &source)?;
                (
                    page["columns"].clone(),
                    page["rows"].clone(),
                    page["cursor"].clone(),
                )
            }
            (None, Some(cursor)) => {
                let page = sources
                    .fetch(&payload.source, cursor, Some(page_rows))
                    .await;
                let page = redacted(page, &source)?;
                (Value::Null, page["rows"].clone(), page["cursor"].clone())
            }
            _ => return Err(refused("Copy either the query or the rest of its cursor")),
        };
        let names: Vec<String> = match &payload.columns {
            Some(names) => names.clone(),
            None => columns
                .as_array()
                .map(|all| {
                    all.iter()
                        .filter_map(|column| column["name"].as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default(),
        };
        let read = rows.as_array().map_or(0, Vec::len);
        if names.is_empty() && read > 0 {
            return Err(refused(
                "The rest of a copy is written into the columns its first page named: send them",
            ));
        }
        let written = if read == 0 {
            json!({"inserted": 0, "upserted": 0, "failed": 0, "failures": []})
        } else {
            let request = json!({
                "connection": payload.target,
                "schema": payload.schema,
                "table": payload.table,
                "columns": names,
                "rows": rows,
                "mode": payload.mode.clone().unwrap_or_else(|| "insert".into()),
                "key": payload.key.clone().unwrap_or_default(),
                "stopOnError": payload.stop_on_error.unwrap_or(false),
                "first": payload.first.unwrap_or(1),
            });
            self.write_batch(sources, &payload.target, &target, request)
                .await?
        };
        // A copy that stopped leaves the source's cursor closed.
        if written["stopped"] == true
            && let Some(open) = cursor.as_str()
        {
            let _ = sources.close(&payload.source, open).await;
        }
        let mut answer = written;
        answer["read"] = json!(read);
        answer["cursor"] = if answer["stopped"] == true {
            Value::Null
        } else {
            cursor
        };
        if !columns.is_null() {
            answer["columns"] = columns;
        }
        Ok(answer)
    }
}
