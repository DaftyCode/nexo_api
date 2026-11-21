//! What a comparison of data counts and keeps, and the statements of its script.
use super::{Plan, refused};
use nexo_domain::{
    Result,
    sql::{compare::literal, quote},
};
use serde_json::{Value, json};

/// Differences described, at most; the counts are of all of them.
const KEPT: usize = 1_000;
/// Statements a script holds, at most.
const MAX_STATEMENTS: usize = 100_000;
/// Values bound in one statement, at most (SQL Server takes 2100); keys of several columns go
/// in fewer, each a condition of its own (SQLite nests at most 1000).
pub(super) const MAX_PARAMS: usize = 2_000;

pub(super) struct Tally {
    pub(super) only_source: u64,
    pub(super) only_target: u64,
    pub(super) different: u64,
    pub(super) equal: u64,
    pub(super) kept: Vec<Value>,
    /// Synchronizing: whether to delete, and whether to write a script.
    pub(super) sync: Option<(bool, bool)>,
    pub(super) statements: Vec<String>,
    pub(super) deletes: Vec<Vec<Value>>,
    pub(super) deleted: u64,
}

impl Tally {
    pub fn new(_plan: &Plan, sync: Option<(bool, bool)>) -> Self {
        Self {
            only_source: 0,
            only_target: 0,
            different: 0,
            equal: 0,
            kept: Vec::new(),
            sync,
            statements: Vec::new(),
            deletes: Vec::new(),
            deleted: 0,
        }
    }

    pub(super) fn keep(
        &mut self,
        kind: &str,
        width: usize,
        source: Option<&[Value]>,
        target: Option<&[Value]>,
        columns: Vec<String>,
    ) {
        if self.kept.len() < KEPT {
            let key = source
                .or(target)
                .map(|row| row[..width].to_vec())
                .unwrap_or_default();
            self.kept.push(json!({"kind": kind, "key": key, "source": source, "target": target, "columns": columns}));
        }
    }

    pub fn answer(&self, plan: &Plan) -> Value {
        let total = self.only_source + self.only_target + self.different;
        json!({
            "counts": {"onlySource": self.only_source, "onlyTarget": self.only_target, "different": self.different, "equal": self.equal},
            "key": plan.key.iter().map(|(a, _)| a).collect::<Vec<_>>(),
            "columns": plan.columns.iter().map(|(a, _)| a).collect::<Vec<_>>(),
            "differences": self.kept,
            "complete": total as usize <= KEPT,
        })
    }

    pub fn written(&self) -> Value {
        json!({"inserted": self.only_source, "updated": self.different, "deleted": self.deleted, "equal": self.equal})
    }

    pub fn script(&self, plan: &Plan) -> Result<Value> {
        if self.statements.len() >= MAX_STATEMENTS {
            return Err(refused(format!(
                "The script would have more than {MAX_STATEMENTS} statements: synchronize instead"
            )));
        }
        let mut statements = self.statements.clone();
        statements.extend(self.deletes.iter().map(|key| delete_statement(plan, key)));
        Ok(json!({"statements": statements}))
    }
}

/// The `WHERE` of a row of the target by its key, with literals.
fn where_literal(plan: &Plan, key: &[Value]) -> String {
    let dialect = plan.target.dialect;
    plan.key
        .iter()
        .zip(key)
        .map(|((_, b), value)| format!("{} = {}", quote(b, dialect), literal(value, dialect)))
        .collect::<Vec<_>>()
        .join(" AND ")
}

pub(super) fn delete_statement(plan: &Plan, key: &[Value]) -> String {
    format!(
        "DELETE FROM {} WHERE {};",
        plan.target_table,
        where_literal(plan, key)
    )
}

pub(super) fn insert_statement(plan: &Plan, row: &[Value]) -> String {
    let dialect = plan.target.dialect;
    let names: Vec<String> = plan
        .key
        .iter()
        .chain(&plan.columns)
        .map(|(_, b)| quote(b, dialect))
        .collect();
    let values: Vec<String> = row.iter().map(|value| literal(value, dialect)).collect();
    format!(
        "INSERT INTO {} ({}) VALUES ({});",
        plan.target_table,
        names.join(", "),
        values.join(", ")
    )
}

pub(super) fn update_statement(plan: &Plan, row: &[Value], changed: &[usize]) -> String {
    let dialect = plan.target.dialect;
    let width = plan.key.len();
    let sets: Vec<String> = changed
        .iter()
        .map(|&at| {
            format!(
                "{} = {}",
                quote(&plan.columns[at].1, dialect),
                literal(&row[width + at], dialect)
            )
        })
        .collect();
    format!(
        "UPDATE {} SET {} WHERE {};",
        plan.target_table,
        sets.join(", "),
        where_literal(plan, &row[..width])
    )
}
