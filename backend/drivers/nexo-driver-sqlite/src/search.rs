//! Searching SQLite: the objects of `sqlite_schema` (and the code of views and triggers),
//! and the text of a column as `CAST(… AS TEXT)`.
use nexo_driver_sdk::{
    Value,
    search::{CatalogQuery, SearchCatalog, SearchParams},
};

pub struct SqliteSearch;

impl SearchCatalog for SqliteSearch {
    fn queries(&self, pattern: &str, params: &SearchParams) -> Vec<CatalogQuery> {
        let wants = |kind: &str| params.kinds.is_empty() || params.kinds.iter().any(|k| k == kind);
        let code = if params.code {
            " OR LOWER(COALESCE(sql, '')) LIKE ?1"
        } else {
            ""
        };
        let objects = |types: &str, code: &str| {
            format!(
                "SELECT NULL, tbl_name, name, type, NOT (LOWER(name) LIKE ?1) FROM sqlite_schema \
                 WHERE type IN ({types}) AND name NOT LIKE 'sqlite!_%' ESCAPE '!' \
                 AND (LOWER(name) LIKE ?1{code}) ORDER BY 3"
            )
        };
        let mut queries = Vec::new();
        let mut add = |kind: &'static str, sql: String| {
            queries.push(CatalogQuery {
                kind,
                sql,
                params: vec![Value::Text(pattern.into())],
            })
        };
        if wants("table") {
            add("table", objects("'table'", ""));
        }
        if wants("view") {
            add("view", objects("'view'", code));
        }
        if wants("column") {
            add(
                "column",
                "SELECT NULL, m.name, p.name, m.type, 0 FROM sqlite_schema m \
                 JOIN pragma_table_xinfo(m.name) p WHERE m.type IN ('table', 'view') \
                 AND m.name NOT LIKE 'sqlite!_%' ESCAPE '!' AND LOWER(p.name) LIKE ?1 ORDER BY 2, 3"
                    .into(),
            );
        }
        if wants("index") {
            add("index", objects("'index'", ""));
        }
        // SQLite has no routines: its triggers hold its code.
        if wants("function") {
            add("function", objects("'trigger'", code));
        }
        queries
    }

    fn path(
        &self,
        kind: &str,
        _schema: Option<&str>,
        table: Option<&str>,
        name: &str,
        identity: Option<&str>,
    ) -> Vec<String> {
        match (kind, identity) {
            ("view", _) => vec!["views".into(), name.into()],
            ("table", _) => vec!["tables".into(), name.into()],
            (_, Some("view")) => vec!["views".into(), table.unwrap_or(name).into()],
            _ => vec!["tables".into(), table.unwrap_or(name).into()],
        }
    }

    fn text_of(&self, column: &str, kind: &str) -> Option<String> {
        (kind != "binary").then(|| format!("CAST({column} AS TEXT)"))
    }
}
