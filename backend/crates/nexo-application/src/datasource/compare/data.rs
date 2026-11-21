//! The data of two tables (`db.compare.data`) and what makes the target's like the source's
//! (`db.sync.data`), a page at a time and never whole in memory: the source is read in pages
//! by its key and each page's keys are looked up in the target; then the target is read the
//! same way to find what the source lacks. Looking up instead of merging two sorted reads
//! keeps the comparison right when the engines sort text differently. Values are compared
//! with `nexo_domain::sql::compare::canonical`, normalized between engines.
mod plan;
mod rows;
mod tally;

use plan::Plan;
use plan::{names, qualified};

use super::{Application, refused};
use crate::{
    datasource::redacted,
    payloads::DbCompareDataPayload,
    ports::{DataSources, StatementRequest},
};
use nexo_domain::{
    Result,
    sql::{ConnectionType, StatementKind, classify},
};
use serde_json::Value;
use tally::Tally;

/// Rows read at a time from each side, and so keys looked up at once.
const PAGE: u32 = 500;

impl Application {
    /// Both tables, their key and the columns compared, checked before anything is read.
    async fn data_plan(
        &self,
        sources: &dyn DataSources,
        payload: &DbCompareDataPayload,
    ) -> Result<Plan> {
        let (source, target) = (
            self.compared_side(&payload.source.session)?,
            self.compared_side(&payload.target.session)?,
        );
        let a = self
            .compared_model(sources, &source, &payload.source.path)
            .await?;
        let b = self
            .compared_model(sources, &target, &payload.target.path)
            .await?;
        let between = source.dialect != target.dialect;
        let (names_a, names_b) = (names(&a), names(&b));
        let pair = |name: &str| {
            names_b
                .iter()
                .find(|other| *other == name || other.to_lowercase() == name.to_lowercase())
                .cloned()
        };
        let key: Vec<String> = match payload.key.as_ref().filter(|key| !key.is_empty()) {
            Some(key) => key.clone(),
            None => a["primaryKey"]["columns"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|c| c.as_str().map(String::from))
                .collect(),
        };
        if key.is_empty() {
            return Err(refused(
                "Choose the columns that pair the rows: the source table has no primary key",
            ));
        }
        let key = key
            .iter()
            .map(|name| {
                let own = names_a
                    .iter()
                    .find(|other| *other == name)
                    .ok_or_else(|| refused(format!("The source has no column {name}")))?;
                let other =
                    pair(own).ok_or_else(|| refused(format!("The target has no column {name}")))?;
                Ok((own.clone(), other))
            })
            .collect::<Result<Vec<_>>>()?;
        let ignore = payload.ignore.clone().unwrap_or_default();
        let columns: Vec<(String, String)> = names_a
            .iter()
            .filter(|name| {
                !key.iter().any(|(own, _)| own == *name)
                    && !ignore.iter().any(|other| other.eq_ignore_ascii_case(name))
            })
            .filter_map(|name| pair(name).map(|other| (name.clone(), other)))
            .collect();
        let filter = payload
            .filter
            .clone()
            .unwrap_or_default()
            .trim()
            .to_string();
        if !filter.is_empty() {
            let probe = format!("SELECT 1 FROM t WHERE ({filter})");
            if filter.contains(';') || classify(&probe, source.dialect).kind != StatementKind::Read
            {
                return Err(refused(
                    "The filter is a condition that only reads, without ;",
                ));
            }
        }
        Ok(Plan {
            source_table: qualified(&payload.source, source.dialect),
            target_table: qualified(&payload.target, target.dialect),
            target_ref: payload.target.clone(),
            source,
            target,
            key,
            columns,
            filter,
            statement: payload
                .statement
                .clone()
                .unwrap_or_else(|| "compare".into()),
            between,
        })
    }

    /// Runs a read of a side and answers its rows; with a cursor, the next page.
    async fn compared_page(
        &self,
        sources: &dyn DataSources,
        plan: &Plan,
        source: bool,
        sql: Option<(String, Vec<Value>)>,
        cursor: Option<&str>,
    ) -> Result<(Vec<Vec<Value>>, Option<String>)> {
        let side = if source { &plan.source } else { &plan.target };
        let answer = match (sql, cursor) {
            (_, Some(cursor)) => sources.fetch(&side.name, cursor, Some(PAGE)).await,
            (Some((sql, params)), None) => {
                let request = StatementRequest {
                    statement: plan.statement.clone(),
                    sql,
                    params,
                    page_rows: Some(PAGE * 2),
                    max_rows: None,
                    timeout: side.session.timeout,
                };
                sources.execute(&side.name, request).await
            }
            (None, None) => return Ok((Vec::new(), None)),
        };
        let answer = redacted(answer, &side.session)?;
        let rows = answer["rows"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|row| row.as_array().cloned().unwrap_or_default())
            .collect();
        Ok((rows, answer["cursor"].as_str().map(String::from)))
    }

    pub(in crate::datasource) async fn compare_data(
        &self,
        sources: &dyn DataSources,
        payload: DbCompareDataPayload,
    ) -> Result<Value> {
        let plan = self.data_plan(sources, &payload).await?;
        let mut tally = Tally::new(&plan, None);
        self.compare_walk(sources, &plan, &mut tally).await?;
        Ok(tally.answer(&plan))
    }

    pub(in crate::datasource) async fn sync_data(
        &self,
        sources: &dyn DataSources,
        payload: DbCompareDataPayload,
    ) -> Result<Value> {
        let plan = self.data_plan(sources, &payload).await?;
        let target = &plan.target.session;
        if payload.source.session == payload.target.session
            && payload.source.schema == payload.target.schema
            && payload.source.table == payload.target.table
        {
            return Err(refused("The source and the target are the same table"));
        }
        let script = payload.script == Some(true);
        if !script {
            if target.read_only {
                return Err(refused(format!(
                    "The connection {} is read-only: its rows cannot change",
                    target.name
                )));
            }
            if payload.confirm_name.as_deref() != Some(payload.target.table.as_str()) {
                return Err(refused(
                    "Type the name of the target table to change its rows",
                ));
            }
            if target.kind == ConnectionType::Production && payload.confirm != Some(true) {
                return Err(refused(format!(
                    "The connection {} is for production: confirm the changes first",
                    target.name
                )));
            }
        }
        let mut tally = Tally::new(&plan, Some((payload.delete == Some(true), script)));
        if script {
            self.compare_walk(sources, &plan, &mut tally).await?;
            return tally.script(&plan);
        }
        let name = plan.target.name.clone();
        redacted(sources.transaction(&name, "begin", None).await, target)?;
        match self.compare_walk(sources, &plan, &mut tally).await {
            Ok(()) => {
                redacted(sources.transaction(&name, "commit", None).await, target)?;
                Ok(tally.written())
            }
            Err(error) => {
                let _ = sources.transaction(&name, "rollback", None).await;
                Err(error)
            }
        }
    }
}
