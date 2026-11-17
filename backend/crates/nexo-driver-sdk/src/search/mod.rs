//! Searching a connection (`search`): its objects by name (and, optionally, the code of its
//! views and routines), or a text or number in the data of chosen tables. Every driver
//! answers it with [`run`] and its engine's [`SearchCatalog`]: the data search is the same
//! for all of them; the catalog says how its engine lists objects and where each one is in
//! the tree.
mod data;
mod metadata;
#[cfg(test)]
mod tests;

pub use data::{like_pattern, matches};
pub use metadata::name_pattern;

use crate::{Result, Value, protocol::Dialect};
use serde::{Deserialize, Serialize};

/// Hits a metadata search answers when it does not say.
pub const MAX_HITS: u32 = 500;
/// Rows of each table a data search keeps when it does not say.
pub const MAX_ROWS: u32 = 100;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchMode {
    #[default]
    Metadata,
    Data,
}

/// A table whose data is searched, and its place in the tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchTable {
    #[serde(default)]
    pub schema: Option<String>,
    pub name: String,
    #[serde(default)]
    pub path: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchParams {
    pub connection: String,
    /// The name of this run, to cancel the query it is in.
    pub statement: String,
    #[serde(default)]
    pub mode: SearchMode,
    pub text: String,
    /// Metadata: the kinds looked for (`table`, `view`, `column`, `index`, `function`,
    /// `constraint`); all when empty.
    #[serde(default)]
    pub kinds: Vec<String>,
    /// Metadata: also in the code of views and routines, and in comments.
    #[serde(default)]
    pub code: bool,
    /// Metadata: only in these schemas (or databases); all when empty.
    #[serde(default)]
    pub schemas: Vec<String>,
    #[serde(default)]
    pub max: Option<u32>,
    /// Data: the tables searched.
    #[serde(default)]
    pub tables: Vec<SearchTable>,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    /// Data: the classes of columns looked at, `text` and `number`; both when empty.
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default)]
    pub max_rows: Option<u32>,
}

/// An object found by name or code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectHit {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    /// The table a column, an index or a constraint belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table: Option<String>,
    pub name: String,
    /// Where it is in the tree, to open it.
    pub path: Vec<String>,
    /// Found in its code or comment, not in its name.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub in_code: bool,
}

/// A table whose data holds what was looked for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataHit {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub table: String,
    pub path: Vec<String>,
    /// The columns where it was found.
    pub matched: Vec<String>,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    /// More rows held it than were kept.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub more: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchResult {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub objects: Vec<ObjectHit>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub data: Vec<DataHit>,
    /// More objects matched than were kept.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub more: bool,
}

/// A query of the catalog for one kind of object. Its rows hold, in order, the schema, the
/// table (or `NULL`), the name, an identity for the tree path (an oid, or `NULL`), and
/// whether it was found in code.
#[derive(Debug, Clone, PartialEq)]
pub struct CatalogQuery {
    pub kind: &'static str,
    pub sql: String,
    pub params: Vec<Value>,
}

/// How one engine searches: its catalog's queries, where an object is in the tree, and how a
/// column's value is read as text to compare.
pub trait SearchCatalog: Send + Sync {
    /// The queries for objects named like `pattern` (a `LIKE` pattern, lower case), of the
    /// kinds asked.
    fn queries(&self, pattern: &str, params: &SearchParams) -> Vec<CatalogQuery>;
    /// The tree path of a hit: kind, schema, table, name and identity as the query gave them.
    fn path(
        &self,
        kind: &str,
        schema: Option<&str>,
        table: Option<&str>,
        name: &str,
        identity: Option<&str>,
    ) -> Vec<String>;
    /// The text of a column of `kind` as SQL, to compare with `LIKE`; none when it holds no
    /// text worth searching (binaries, geometries).
    fn text_of(&self, column: &str, kind: &str) -> Option<String>;
}

pub use run::run;
mod run;

/// `"name"` in the dialect's quotes.
pub(crate) fn quoted(dialect: &Dialect, name: &str) -> String {
    let (open, close) = (&dialect.quote_open, &dialect.quote_close);
    format!(
        "{open}{}{close}",
        name.replace(close.as_str(), &close.repeat(2))
    )
}

/// The placeholder of the `at`-th value of a statement, from 1.
pub(crate) fn placeholder(dialect: &Dialect, at: usize) -> String {
    match dialect.parameters {
        crate::protocol::ParameterStyle::Numbered => format!("${at}"),
        crate::protocol::ParameterStyle::Question => "?".into(),
        crate::protocol::ParameterStyle::Named => format!("@P{at}"),
    }
}

/// The result of a search with nothing found.
pub fn nothing() -> Result<SearchResult> {
    Ok(SearchResult::default())
}
