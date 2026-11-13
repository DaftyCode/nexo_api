//! Statements: run with bound values, read by pages from a cursor of the server (so a large
//! result never sits in memory), cancelled through another connection as `psql` does, and
//! the transaction they belong to.
use crate::{
    connection::{Cursor, PgConnection, TxState},
    errors::database,
    params::param,
    values,
};
use nexo_driver_sdk::{
    DriverError, Result, limits,
    statements::{ExecuteParams, ExecuteResult, Page},
};
use std::{sync::atomic::Ordering, time::Instant};

mod control;
use tokio_postgres::{
    Row,
    types::{ToSql, Type},
};

/// The first word of a statement, upper case, past comments.
fn first_word(sql: &str) -> String {
    let mut rest = sql.trim_start();
    loop {
        if let Some(line) = rest.strip_prefix("--") {
            rest = line
                .split_once('\n')
                .map_or("", |(_, after)| after)
                .trim_start();
        } else if let Some(block) = rest.strip_prefix("/*") {
            rest = block
                .split_once("*/")
                .map_or("", |(_, after)| after)
                .trim_start();
        } else {
            break;
        }
    }
    rest.split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase()
}

/// Statements a cursor can read: `DECLARE … CURSOR FOR` takes only queries.
fn cursorable(word: &str) -> bool {
    matches!(word, "SELECT" | "VALUES" | "TABLE" | "WITH")
}

impl PgConnection {
    /// Follows the transaction the statement opens or ends, when it is one of those.
    fn follow(&self, word: &str, sql: &str) {
        let mut state = self.state.lock().unwrap();
        match word {
            "BEGIN" | "START" => state.open = true,
            "COMMIT" | "END" | "ABORT" => state.open = false,
            "ROLLBACK" if !sql.to_ascii_uppercase().contains(" TO ") => state.open = false,
            _ => {}
        }
    }

    fn notices(&self) -> Vec<nexo_driver_sdk::statements::Notice> {
        std::mem::take(&mut *self.main.notices.lock().unwrap())
    }

    pub async fn execute(&self, params: ExecuteParams) -> Result<ExecuteResult> {
        self.running
            .lock()
            .unwrap()
            .insert(params.statement.clone());
        let result = self.run(&params).await;
        self.running.lock().unwrap().remove(&params.statement);
        result
    }

    async fn run(&self, params: &ExecuteParams) -> Result<ExecuteResult> {
        let (client, sql) = (&self.main.client, params.sql.as_str());
        let failed = |error| database(error, Some(sql));
        let started = Instant::now();
        self.notices();
        let word = first_word(sql);
        let control = matches!(
            word.as_str(),
            "BEGIN" | "START" | "COMMIT" | "END" | "ROLLBACK" | "ABORT"
        );
        let TxState { auto, open } = *self.state.lock().unwrap();
        if !auto && !open && !control {
            client.batch_execute("BEGIN").await.map_err(failed)?;
            self.state.lock().unwrap().open = true;
        }
        let values: Vec<_> = params.params.iter().map(param).collect();
        let bound: Vec<&(dyn ToSql + Sync)> = values.iter().map(|value| value as _).collect();
        let types = vec![Type::UNKNOWN; values.len()];
        let statement = client.prepare_typed(sql, &types).await.map_err(failed)?;
        if statement.columns().is_empty() {
            let affected = client
                .execute_raw(&statement, bound)
                .await
                .map_err(failed)?;
            self.follow(&word, sql);
            return Ok(ExecuteResult {
                affected: Some(affected),
                notices: self.notices(),
                elapsed_ms: started.elapsed().as_millis() as u64,
                ..ExecuteResult::default()
            });
        }
        let tables: Vec<u32> = statement
            .columns()
            .iter()
            .filter_map(|column| column.table_oid())
            .collect();
        let sources = self.sources(tables).await;
        let columns = values::columns(statement.columns(), &|table, position| {
            sources.get(&(table, position)).cloned()
        });
        let page = limits::page_rows(params.page_rows) as u64;
        let first_page = params.max_rows.map_or(page, |max| max.min(page));
        let (rows, cursor) = if cursorable(&word) {
            let name = format!(
                "nexo_cursor_{}",
                self.counter.fetch_add(1, Ordering::Relaxed)
            );
            // Outside a transaction a cursor must outlive the statement that opens it.
            let hold = if self.state.lock().unwrap().open {
                ""
            } else {
                " WITH HOLD"
            };
            let declare = format!("DECLARE {name} NO SCROLL CURSOR{hold} FOR {sql}");
            let declared = client
                .prepare_typed(&declare, &types)
                .await
                .map_err(failed)?;
            client.execute_raw(&declared, bound).await.map_err(failed)?;
            let rows = self.read(&name, first_page).await?;
            let more = rows.len() as u64 == first_page
                && params.max_rows.is_none_or(|max| max > first_page);
            if more {
                self.keep(Cursor {
                    name: name.clone(),
                    read: first_page,
                    max: params.max_rows,
                })
                .await;
            } else {
                let _ = client.batch_execute(&format!("CLOSE {name}")).await;
            }
            (rows, more.then_some(name))
        } else {
            // Statements a cursor cannot read (`INSERT … RETURNING`, `SHOW`, `EXPLAIN`): their
            // first page, and a notice when there was more.
            let rows = client.query_raw(&statement, bound).await.map_err(failed)?;
            let mut rows = std::pin::pin!(rows);
            let mut read = Vec::new();
            let mut cut = false;
            while let Some(row) = futures_util::TryStreamExt::try_next(&mut rows)
                .await
                .map_err(failed)?
            {
                if read.len() as u64 == first_page {
                    cut = true;
                    continue;
                }
                read.push(row);
            }
            if cut {
                self.main.notices.lock().unwrap().push(nexo_driver_sdk::statements::Notice {
                    severity: "warning".into(),
                    message: format!("Only the first {first_page} rows are shown: this statement cannot be read by pages"),
                });
            }
            (read, None)
        };
        self.follow(&word, sql);
        Ok(ExecuteResult {
            columns,
            rows: rows.iter().map(values::row).collect(),
            cursor,
            affected: None,
            notices: self.notices(),
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }

    async fn read(&self, cursor: &str, count: u64) -> Result<Vec<Row>> {
        let fetch = format!("FETCH FORWARD {count} FROM {cursor}");
        self.main
            .client
            .query(&fetch, &[])
            .await
            .map_err(|error| database(error, None))
    }

    /// Keeps a cursor; the oldest one is closed when there are too many.
    async fn keep(&self, cursor: Cursor) {
        let oldest = {
            let mut cursors = self.cursors.lock().unwrap();
            cursors.push(cursor);
            (cursors.len() > limits::CURSORS).then(|| cursors.remove(0))
        };
        if let Some(oldest) = oldest {
            let _ = self
                .main
                .client
                .batch_execute(&format!("CLOSE {}", oldest.name))
                .await;
        }
    }

    pub async fn fetch(&self, cursor: &str, page_rows: Option<u32>) -> Result<Page> {
        let (read, max) = {
            let cursors = self.cursors.lock().unwrap();
            let found = cursors
                .iter()
                .find(|open| open.name == cursor)
                .ok_or_else(|| DriverError::invalid("The cursor is not open"))?;
            (found.read, found.max)
        };
        let page = limits::page_rows(page_rows) as u64;
        let count = max.map_or(page, |max| max.saturating_sub(read).min(page));
        let rows = self.read(cursor, count).await?;
        let more = rows.len() as u64 == count && max.is_none_or(|max| read + count < max);
        if more {
            if let Some(open) = self
                .cursors
                .lock()
                .unwrap()
                .iter_mut()
                .find(|open| open.name == cursor)
            {
                open.read += count;
            }
        } else {
            self.close(cursor).await?;
        }
        Ok(Page {
            rows: rows.iter().map(values::row).collect(),
            cursor: more.then(|| cursor.to_owned()),
        })
    }

    pub async fn close(&self, cursor: &str) -> Result<()> {
        let removed = {
            let mut cursors = self.cursors.lock().unwrap();
            let index = cursors
                .iter()
                .position(|open| open.name == cursor)
                .ok_or_else(|| DriverError::invalid("The cursor is not open"))?;
            cursors.remove(index)
        };
        // A cursor of a transaction that ended is already gone.
        let _ = self
            .main
            .client
            .batch_execute(&format!("CLOSE {}", removed.name))
            .await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_first_word_past_comments() {
        assert_eq!(first_word("  -- note\n/* a */ select 1"), "SELECT");
        assert_eq!(first_word("with x as (select 1) select * from x"), "WITH");
        assert_eq!(first_word("BEGIN;"), "BEGIN");
        assert!(cursorable("VALUES") && !cursorable("INSERT"));
    }
}
