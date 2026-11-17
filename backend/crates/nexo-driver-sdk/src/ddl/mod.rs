//! Changing the structure of tables (`ddl.model`, `ddl.plan`), as DBeaver's entity editor:
//! the interface edits a model of a table and the driver writes the DDL of its engine for the
//! difference with the original, in order and with warnings. Nothing runs here: the
//! statements go back to the person, who reads them before they run.
//!
//! [`plan`] finds the difference and asks the engine's [`DdlWriter`] for each statement.
mod model;
mod plan;
#[cfg(test)]
mod tests;

pub use model::*;
pub use plan::plan;

/// How an engine makes one change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// These statements, in order.
    Run(Vec<String>),
    /// Not in place: the table is created again and its rows copied (SQLite).
    Rebuild,
    /// Not at all, and why.
    Unsupported(String),
}
impl Step {
    pub fn one(sql: impl Into<String>) -> Self {
        Self::Run(vec![sql.into()])
    }
}

/// How one engine writes each change.
pub trait DdlWriter: Send + Sync {
    /// The table's name as the engine writes it, with its schema.
    fn table(&self, table: &TableModel) -> String;
    fn quote(&self, name: &str) -> String;
    /// A column as it is declared in `CREATE TABLE` and `ADD COLUMN`.
    fn column(&self, table: &TableModel, column: &ColumnModel) -> String;
    /// `CREATE TABLE` with its columns and constraints, then what goes apart (comments).
    fn create(&self, table: &TableModel) -> Vec<String>;
    fn drop(&self, table: &TableModel, cascade: bool) -> Vec<String>;
    fn rename_table(&self, table: &TableModel, to: &str) -> Step;
    fn table_comment(&self, table: &TableModel, before: Option<&str>, after: Option<&str>) -> Step;
    fn add_column(&self, table: &TableModel, column: &ColumnModel) -> Step;
    fn drop_column(&self, table: &TableModel, column: &str) -> Step;
    fn rename_column(&self, table: &TableModel, from: &str, to: &str) -> Step;
    /// The column changed its type, nullability, default or identity.
    fn alter_column(&self, table: &TableModel, before: &ColumnModel, after: &ColumnModel) -> Step;
    fn column_comment(&self, table: &TableModel, before: &ColumnModel, after: &ColumnModel)
    -> Step;
    /// A constraint (primary key, unique, check or foreign key) of a table that exists.
    fn add_constraint(&self, table: &TableModel, constraint: &Constraint) -> Step;
    fn drop_constraint(&self, table: &TableModel, constraint: &Constraint) -> Step;
    fn create_index(&self, table: &TableModel, index: &IndexModel) -> String;
    fn drop_index(&self, table: &TableModel, index: &IndexModel) -> String;
    /// Whether a failure half way can be rolled back: the plan says so when not.
    fn transactional(&self) -> bool;
}

/// What the plan answers: the statements in order, and what the person should know first.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DdlPlan {
    pub statements: Vec<String>,
    pub warnings: Vec<String>,
    /// The engine rolls changes of structure back: the statements can go in a transaction.
    pub transactional: bool,
}

/// A column of an index (`name` or `name DESC`) quoted; an expression as it was written.
pub fn index_part(writer: &dyn DdlWriter, column: &str) -> String {
    let (name, order) = match column.strip_suffix(" DESC") {
        Some(name) => (name, " DESC"),
        None => (column, ""),
    };
    if name.contains('(') || name.contains(' ') {
        format!("{name}{order}")
    } else {
        format!("{}{order}", writer.quote(name))
    }
}
