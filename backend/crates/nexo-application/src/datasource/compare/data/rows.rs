//! The two passes over the rows: the source's pages looked up in the target (rows only the
//! source has, and rows that differ), then the target's looked up in the source (rows only
//! the target has). Synchronizing writes as it goes: what the source has, by key (`upsert`),
//! and at the end, when asked, deletes what only the target has. A script writes the same
//! as statements instead.
use super::tally::{MAX_PARAMS, Tally, insert_statement, update_statement};
use super::{Application, Plan, refused};
use crate::datasource::redacted;
use crate::ports::{DataSources, StatementRequest};
use nexo_domain::{Result, sql::compare::canonical};
use serde_json::{Value, json};
use std::collections::HashMap;

/// Keys looked up or deleted in one statement.
fn batch(width: usize) -> usize {
    if width == 1 {
        MAX_PARAMS / 4
    } else {
        (MAX_PARAMS / width).min(200)
    }
}

impl Application {
    /// The rows of one side whose keys are those of `rows`, by the canonical text of the key.
    async fn compared_found(
        &self,
        sources: &dyn DataSources,
        plan: &Plan,
        source: bool,
        rows: &[Vec<Value>],
        full: bool,
    ) -> Result<HashMap<String, Vec<Value>>> {
        let width = plan.key.len();
        let mut found = HashMap::new();
        for chunk in rows.chunks(batch(width)) {
            let keys: Vec<Vec<Value>> = chunk.iter().map(|row| row[..width].to_vec()).collect();
            let (rows, cursor) = self
                .compared_page(
                    sources,
                    plan,
                    source,
                    Some(plan.lookup(source, &keys, full)),
                    None,
                )
                .await?;
            if let Some(cursor) = cursor {
                let side = if source { &plan.source } else { &plan.target };
                let _ = sources.close(&side.name, &cursor).await;
            }
            for row in rows {
                found.insert(plan.key_text(&row[..width.min(row.len())]), row);
            }
        }
        Ok(found)
    }

    /// Writes rows of the source into the target by key, in the open transaction.
    async fn sync_upsert(
        &self,
        sources: &dyn DataSources,
        plan: &Plan,
        rows: Vec<Vec<Value>>,
    ) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let columns: Vec<&String> = plan
            .key
            .iter()
            .chain(&plan.columns)
            .map(|(_, b)| b)
            .collect();
        let request = json!({
            "connection": plan.target.name, "schema": plan.target_ref.schema, "table": plan.target_ref.table,
            "columns": columns, "rows": rows, "mode": "upsert",
            "key": plan.key.iter().map(|(_, b)| b).collect::<Vec<_>>(), "stopOnError": true,
        });
        let answer = self
            .write_batch(sources, &plan.target.name, &plan.target.session, request)
            .await?;
        if answer["failed"].as_u64().unwrap_or(0) > 0 || answer["stopped"] == true {
            let why = answer["failures"][0]["error"]
                .as_str()
                .unwrap_or("a row could not be written");
            return Err(refused(format!(
                "The synchronization stopped and changed nothing: {why}"
            )));
        }
        Ok(())
    }

    /// Both passes, counting and keeping what they find, and writing when synchronizing.
    pub(super) async fn compare_walk(
        &self,
        sources: &dyn DataSources,
        plan: &Plan,
        tally: &mut Tally,
    ) -> Result<()> {
        let width = plan.key.len();
        let writes = matches!(tally.sync, Some((_, false)));
        let script = matches!(tally.sync, Some((_, true)));
        let (mut rows, mut cursor) = self
            .compared_page(
                sources,
                plan,
                true,
                Some((plan.scan(true), Vec::new())),
                None,
            )
            .await?;
        loop {
            let others = self
                .compared_found(sources, plan, false, &rows, true)
                .await?;
            let mut upserts = Vec::new();
            for row in &rows {
                match others.get(&plan.key_text(&row[..width])) {
                    None => {
                        tally.only_source += 1;
                        tally.keep("onlySource", width, Some(row), None, Vec::new());
                        if script {
                            tally.statements.push(insert_statement(plan, row));
                        }
                        upserts.push(row.clone());
                    }
                    Some(other) => {
                        let changed: Vec<usize> = (0..plan.columns.len())
                            .filter(|&at| {
                                canonical(&row[width + at], plan.between)
                                    != canonical(&other[width + at], plan.between)
                            })
                            .collect();
                        if changed.is_empty() {
                            tally.equal += 1;
                            continue;
                        }
                        tally.different += 1;
                        let names = changed
                            .iter()
                            .map(|&at| plan.columns[at].0.clone())
                            .collect();
                        tally.keep("different", width, Some(row), Some(other), names);
                        if script {
                            tally.statements.push(update_statement(plan, row, &changed));
                        }
                        upserts.push(row.clone());
                    }
                }
            }
            if writes {
                self.sync_upsert(sources, plan, upserts).await?;
            }
            match cursor {
                Some(next) => {
                    (rows, cursor) = self
                        .compared_page(sources, plan, true, None, Some(&next))
                        .await?
                }
                None => break,
            }
        }
        let (mut rows, mut cursor) = self
            .compared_page(
                sources,
                plan,
                false,
                Some((plan.scan(false), Vec::new())),
                None,
            )
            .await?;
        loop {
            let others = self
                .compared_found(sources, plan, true, &rows, false)
                .await?;
            for row in rows
                .iter()
                .filter(|row| !others.contains_key(&plan.key_text(&row[..width])))
            {
                tally.only_target += 1;
                tally.keep("onlyTarget", width, None, Some(row), Vec::new());
                if matches!(tally.sync, Some((true, _))) {
                    tally.deletes.push(row[..width].to_vec());
                }
            }
            match cursor {
                Some(next) => {
                    (rows, cursor) = self
                        .compared_page(sources, plan, false, None, Some(&next))
                        .await?
                }
                None => break,
            }
        }
        if writes {
            self.sync_delete(sources, plan, tally).await?;
        }
        Ok(())
    }

    /// Deletes the rows only the target has, a batch of keys at a time.
    async fn sync_delete(
        &self,
        sources: &dyn DataSources,
        plan: &Plan,
        tally: &mut Tally,
    ) -> Result<()> {
        let width = plan.key.len();
        let keys = std::mem::take(&mut tally.deletes);
        for chunk in keys.chunks(batch(width)) {
            let (select, params) = plan.lookup(false, chunk, false);
            let condition = select
                .split_once(" WHERE ")
                .map(|(_, rest)| rest.to_string())
                .unwrap_or_default();
            let sql = format!("DELETE FROM {} WHERE {condition}", plan.target_table);
            let request = StatementRequest {
                statement: plan.statement.clone(),
                sql: sql.clone(),
                params,
                page_rows: None,
                max_rows: None,
                timeout: plan.target.session.timeout,
            };
            let started = std::time::Instant::now();
            let answer = redacted(
                sources.execute(&plan.target.name, request).await,
                &plan.target.session,
            )?;
            let affected = answer["affected"].as_u64().unwrap_or(chunk.len() as u64);
            tally.deleted += affected;
            plan.target.session.journal.lock().unwrap().statement(
                &sql,
                started.elapsed(),
                Some(affected),
                true,
            );
        }
        Ok(())
    }
}
