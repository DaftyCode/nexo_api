//! Comparing two databases (DB-24): their structure (`db.compare.schema`), the DDL that makes
//! one like the other (`db.compare.script`), and their data (`db.compare.data`,
//! `db.sync.data`). Each side is a session of its own connection, of the same engine or
//! another; the objects are read with the drivers (`db.tree`, `ddl.model`, `ddl`) and
//! compared with `nexo_domain::sql::compare`.
mod data;
mod entries;
mod script;

use entries::{Comparison, Entry};

use super::{redacted, sessions::Session, sessions::session_name};
use crate::{
    Application,
    payloads::{CompareSide, DbCompareSchemaPayload},
    ports::DataSources,
};
use nexo_domain::{
    Error, Result,
    sql::{Dialect, compare::Options},
};
use serde_json::{Value, json};
use std::sync::Arc;

/// Objects read from a side, at most.
const MAX_OBJECTS: usize = 2_000;
/// Nodes of the tree asked for while looking for them.
const MAX_LOOKS: usize = 200;

pub(super) fn refused(message: impl Into<String>) -> Error {
    Error::Validation(message.into())
}

/// An object of a side: its kind, its name and its path in the tree.
#[derive(Clone)]
pub(super) struct Object {
    pub kind: String,
    pub name: String,
    pub path: Vec<String>,
}

/// A side: its session and what its engine is.
pub(super) struct Side {
    pub name: String,
    pub session: Arc<Session>,
    pub dialect: Dialect,
}

impl Application {
    pub(super) fn compared_side(&self, session: &str) -> Result<Side> {
        let name = session_name(session)?.to_string();
        let session = self.sql_sessions.get(&name)?;
        let dialect = Dialect::parse(&session.driver);
        Ok(Side {
            name,
            session,
            dialect,
        })
    }

    /// The objects under a schema or database: tables, views, routines, sequences…, looking
    /// inside the folders of its tree but not inside the objects.
    pub(super) async fn compared_objects(
        &self,
        sources: &dyn DataSources,
        side: &Side,
        path: &[String],
    ) -> Result<Vec<Object>> {
        let mut found = Vec::new();
        let mut pending = vec![path.to_vec()];
        let mut looks = 0;
        while let Some(at) = pending.pop() {
            looks += 1;
            if looks > MAX_LOOKS || found.len() >= MAX_OBJECTS {
                break;
            }
            let answer = redacted(sources.tree(&side.name, at.clone()).await, &side.session)?;
            for node in answer["nodes"].as_array().into_iter().flatten() {
                let (kind, name) = (
                    node["kind"].as_str().unwrap_or_default(),
                    node["name"].as_str().unwrap_or_default(),
                );
                if node["system"] == true || name.is_empty() || matches!(kind, "index" | "column") {
                    continue;
                }
                let mut path = at.clone();
                path.push(name.to_string());
                if kind == "folder" {
                    pending.push(path);
                } else if !matches!(kind, "schema" | "database") {
                    found.push(Object {
                        kind: kind.to_string(),
                        name: name.to_string(),
                        path,
                    });
                }
            }
        }
        found.sort_by(|a, b| (&a.kind, &a.name).cmp(&(&b.kind, &b.name)));
        Ok(found)
    }

    /// The model of a table (`ddl.model`), as its driver writes it.
    pub(super) async fn compared_model(
        &self,
        sources: &dyn DataSources,
        side: &Side,
        path: &[String],
    ) -> Result<Value> {
        let request = json!({"connection": side.name, "path": path});
        let answer = redacted(sources.ddl_model(&side.name, request).await, &side.session)?;
        Ok(answer["table"].clone())
    }

    pub(in crate::datasource) async fn compare_schema(
        &self,
        sources: &dyn DataSources,
        payload: DbCompareSchemaPayload,
    ) -> Result<Value> {
        let comparison = self.compared(sources, &payload).await?;
        Ok(comparison.answer())
    }

    /// Both sides read and compared: their tables (with their models) and other objects.
    async fn compared(
        &self,
        sources: &dyn DataSources,
        payload: &DbCompareSchemaPayload,
    ) -> Result<Comparison> {
        let (source, target) = (
            self.compared_side(&payload.source.session)?,
            self.compared_side(&payload.target.session)?,
        );
        let options = Options {
            ignore_comments: payload.ignore_comments.unwrap_or(false),
            ignore_column_order: payload.ignore_column_order.unwrap_or(true),
            ignore_constraint_names: payload.ignore_constraint_names.unwrap_or(true),
            source: source.dialect,
            target: target.dialect,
        };
        let lists = |side: &CompareSide| -> Vec<Object> {
            let name = side.path.last().cloned().unwrap_or_default();
            vec![Object {
                kind: "table".into(),
                name,
                path: side.path.clone(),
            }]
        };
        let (a, b) = if payload.source.table == Some(true) && payload.target.table == Some(true) {
            (lists(&payload.source), lists(&payload.target))
        } else {
            (
                self.compared_objects(sources, &source, &payload.source.path)
                    .await?,
                self.compared_objects(sources, &target, &payload.target.path)
                    .await?,
            )
        };
        let single = payload.source.table == Some(true);
        let same = |x: &Object, y: &Object| {
            single
                || (x.kind == y.kind
                    && if options.between() {
                        x.name.to_lowercase() == y.name.to_lowercase()
                    } else {
                        x.name == y.name
                    })
        };
        let mut entries = Vec::new();
        for x in &a {
            entries.push((Some(x.clone()), b.iter().find(|y| same(x, y)).cloned()));
        }
        for y in b.iter().filter(|y| !a.iter().any(|x| same(x, y))) {
            entries.push((None, Some(y.clone())));
        }
        let mut compared = Vec::new();
        for (x, y) in entries {
            compared.push(
                self.compared_entry(sources, &source, &target, &options, x, y, payload)
                    .await?,
            );
        }
        Ok(Comparison {
            options,
            entries: compared,
        })
    }
}
