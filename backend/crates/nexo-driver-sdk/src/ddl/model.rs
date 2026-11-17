//! The model of a table the interface edits.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ColumnModel {
    pub name: String,
    /// The name it had, to tell a renamed column from a new one; empty for a new column.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub original: String,
    /// The type as the engine writes it: `varchar(50)`, `numeric(10,2)`.
    pub type_name: String,
    pub nullable: bool,
    /// The default as an SQL expression, as written: `0`, `'new'`, `now()`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    /// Filled by the engine: `GENERATED … AS IDENTITY`, `AUTO_INCREMENT`, `IDENTITY(1,1)`.
    pub identity: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

/// A primary key or a unique constraint.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct KeyModel {
    #[serde(skip_serializing_if = "String::is_empty")]
    pub name: String,
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CheckModel {
    #[serde(skip_serializing_if = "String::is_empty")]
    pub name: String,
    pub expression: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ForeignKeyModel {
    #[serde(skip_serializing_if = "String::is_empty")]
    pub name: String,
    pub columns: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub referenced_schema: Option<String>,
    pub referenced_table: String,
    pub referenced_columns: Vec<String>,
    /// `CASCADE`, `SET NULL`, `SET DEFAULT`, `RESTRICT`; `NO ACTION` when empty.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub on_delete: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub on_update: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IndexModel {
    pub name: String,
    /// Columns (or expressions), each with ` DESC` when it goes down.
    pub columns: Vec<String>,
    pub unique: bool,
    /// `btree`, `hash`, `gin`, `gist`, `fulltext`…; the engine's default when empty.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub method: String,
    /// Partial indexes: the rows it holds.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub condition: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TableModel {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub name: String,
    /// The name it had, to rename it; empty for a new table.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub original: String,
    pub columns: Vec<ColumnModel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_key: Option<KeyModel>,
    pub uniques: Vec<KeyModel>,
    pub checks: Vec<CheckModel>,
    pub foreign_keys: Vec<ForeignKeyModel>,
    pub indexes: Vec<IndexModel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    /// Options of the engine (`engine`, `collation` in MySQL…), by name.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub options: BTreeMap<String, String>,
}

/// A constraint of a table, as the writers take it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Constraint {
    PrimaryKey(KeyModel),
    Unique(KeyModel),
    Check(CheckModel),
    ForeignKey(ForeignKeyModel),
}
impl Constraint {
    pub fn name(&self) -> &str {
        match self {
            Self::PrimaryKey(key) | Self::Unique(key) => &key.name,
            Self::Check(check) => &check.name,
            Self::ForeignKey(key) => &key.name,
        }
    }
}

/// What a table model holds besides the table: the types the engine offers, for the editor.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DdlModel {
    pub table: TableModel,
    /// Every type a column may take, the engine's and the user's (domains, enums).
    pub types: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DdlModelParams {
    pub connection: String,
    /// The table's path in the tree; empty for the types alone (a new table).
    #[serde(default)]
    pub path: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DdlPlanParams {
    pub connection: String,
    /// The table as it is; none to create it.
    #[serde(default)]
    pub original: Option<TableModel>,
    /// The table as it should be; none to drop it.
    #[serde(default)]
    pub target: Option<TableModel>,
    #[serde(default)]
    pub cascade: bool,
}
