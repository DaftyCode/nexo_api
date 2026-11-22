//! Tasks with files (DB-40): a query of a connection written to a CSV, JSON or JSON Lines
//! file page after page, and a file written into a table by batches with the import of
//! DB-17. Only the desktop app has the files; `{date}` in a name is the time it runs.
use super::{Authorized, Report};
use crate::{Application, datasource::classify_sql, operations::Operation, ports::TaskFiles};
use nexo_domain::{
    Error, Result, WorkspaceId,
    sql::StatementKind,
    transfer_file::{FileFormat, FileWriter, dated, read_rows},
};
use serde_json::{Value, json};
use std::sync::Arc;

/// Rows of each page read, and of each batch written.
const PAGE: u64 = 1_000;
const BATCH: usize = 500;
/// The largest file a task reads.
pub(super) const READ_LIMIT: u64 = 256 * 1024 * 1024;

/// How a task's file is written: its format, separator and header.
pub(super) fn file_settings(task: &Value) -> Result<(FileFormat, char, bool)> {
    let format = FileFormat::parse(task["format"].as_str().unwrap_or_default())?;
    let separator = task["separator"]
        .as_str()
        .and_then(|text| text.chars().next())
        .unwrap_or(',');
    Ok((format, separator, task["header"] != false))
}

/// The names of the columns of an answer.
fn names(answer: &Value) -> Vec<String> {
    answer["columns"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|column| column["name"].as_str().unwrap_or_default().to_owned())
        .collect()
}

impl Application {
    /// The files of tasks, which only the desktop app has.
    pub(super) fn task_files(&self) -> Result<Arc<dyn TaskFiles>> {
        self.task_files
            .clone()
            .ok_or_else(|| Error::Validation("Tasks with files run in the desktop app".into()))
    }

    /// `export`: what a query reads, written to a file.
    pub(super) async fn run_export(
        &self,
        workspace: &WorkspaceId,
        task: &Value,
        report: &mut Report,
    ) -> Result<()> {
        let files = self.task_files()?;
        let (format, separator, header) = file_settings(task)?;
        let path = dated(task["file"].as_str().unwrap_or_default(), self.task_clock());
        let sql = task["sql"].as_str().unwrap_or_default();
        let session = self
            .task_session(workspace, task["connection"].as_str().unwrap_or_default())
            .await?;
        let outcome = async {
            let driver = self.sql_sessions.get(&session)?.driver.clone();
            if classify_sql(sql, &driver) != StatementKind::Read {
                return Err(Error::Validation(
                    "An export writes what a query reads: the statement changes something".into(),
                ));
            }
            let mut page = self
                .datasource(
                    Operation::DbExecute,
                    json!({"session": session, "statement": format!("{session}-export"),
                           "sql": sql, "pageRows": PAGE}),
                )
                .await?;
            report.statements += 1;
            let written = files.create(&path, task["overwrite"] == true).await?;
            let mut writer = FileWriter::new(format, separator, header, names(&page));
            let mut text = writer.start();
            loop {
                let rows = page["rows"].as_array().cloned().unwrap_or_default();
                text.push_str(&writer.rows(&rows));
                files
                    .append(&written, std::mem::take(&mut text).into_bytes())
                    .await?;
                let Some(cursor) = page["cursor"].as_str().map(str::to_owned) else {
                    break;
                };
                page = self
                    .datasource(
                        Operation::DbFetch,
                        json!({"session": session, "cursor": cursor, "pageRows": PAGE}),
                    )
                    .await?;
            }
            files.append(&written, writer.finish().into_bytes()).await?;
            report.rows += writer.written();
            Ok(())
        }
        .await;
        self.close_session(&session).await;
        outcome
    }

    /// `import`: the rows of a file written into a table.
    pub(super) async fn run_import(
        &self,
        workspace: &WorkspaceId,
        task: &Value,
        report: &mut Report,
    ) -> Result<()> {
        let files = self.task_files()?;
        let (format, separator, _) = file_settings(task)?;
        let path = task["file"].as_str().unwrap_or_default();
        let bytes = files.read(path, READ_LIMIT).await?;
        let text = String::from_utf8(bytes)
            .map_err(|_| Error::Validation(format!("{path} is not UTF-8 text")))?;
        let (columns, rows) = read_rows(&text, format, separator, task["emptyAsNull"] != false)?;
        let stop_on_error = task["stopOnError"] != false;
        let confirm = Authorized::of(task).allows("writes");
        let session = self
            .task_session(workspace, task["connection"].as_str().unwrap_or_default())
            .await?;
        let outcome = async {
            let (mut failed, mut first_failure) = (0_u64, None);
            for (at, batch) in rows.chunks(BATCH).enumerate() {
                let mut request = json!({
                    "session": session,
                    "table": task["table"],
                    "columns": columns,
                    "rows": batch,
                    "mode": task["mode"].as_str().unwrap_or("insert"),
                    "stopOnError": stop_on_error,
                    "first": at * BATCH + 1,
                    "confirm": confirm,
                });
                for field in ["schema", "key"] {
                    if !task[field].is_null() {
                        request[field] = task[field].clone();
                    }
                }
                let answer = self.datasource(Operation::DbImport, request).await?;
                report.statements += 1;
                report.rows += answer["inserted"].as_u64().unwrap_or(0)
                    + answer["upserted"].as_u64().unwrap_or(0);
                failed += answer["failed"].as_u64().unwrap_or(0);
                if first_failure.is_none() {
                    first_failure = answer["failures"][0]
                        .as_object()
                        .map(|failure| Value::Object(failure.clone()));
                }
                if answer["stopped"] == true {
                    break;
                }
            }
            match first_failure {
                Some(failure) if failed > 0 => Err(Error::Validation(format!(
                    "{failed} rows were refused; row {}: {}",
                    failure["position"],
                    failure["error"].as_str().unwrap_or_default()
                ))),
                _ => Ok(()),
            }
        }
        .await;
        self.close_session(&session).await;
        outcome
    }
}
