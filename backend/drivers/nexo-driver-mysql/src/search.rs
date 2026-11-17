//! Searching MySQL and MariaDB: their objects in `information_schema` (and the code of views
//! and routines, and comments), and the text of a column as `CAST(… AS CHAR)`.
use nexo_driver_sdk::{
    Value,
    search::{CatalogQuery, SearchCatalog, SearchParams},
};

/// Databases of the system, never searched.
const SYSTEM: [&str; 4] = ["mysql", "sys", "information_schema", "performance_schema"];

pub struct MysqlSearch;

impl SearchCatalog for MysqlSearch {
    fn queries(&self, pattern: &str, params: &SearchParams) -> Vec<CatalogQuery> {
        let wants = |kind: &str| params.kinds.is_empty() || params.kinds.iter().any(|k| k == kind);
        let mut queries = Vec::new();
        // Every `?` takes its own value: the pattern where it is matched, then the databases.
        let mut add = |kind: &'static str, column: &str, sql: String, matches: usize| {
            let schema_filter = if params.schemas.is_empty() {
                format!(
                    "{column} NOT IN ({})",
                    SYSTEM.map(|name| format!("'{name}'")).join(", ")
                )
            } else {
                format!(
                    "{column} IN ({})",
                    vec!["?"; params.schemas.len()].join(", ")
                )
            };
            let mut values = vec![Value::Text(pattern.into()); matches];
            values.extend(
                params
                    .schemas
                    .iter()
                    .map(|schema| Value::Text(schema.clone())),
            );
            queries.push(CatalogQuery {
                kind,
                sql: sql.replace("{schemas}", &schema_filter),
                params: values,
            });
        };
        let code = params.code;
        let or_code = |source: &str| {
            if code {
                format!(" OR LOWER(COALESCE({source}, '')) LIKE ?")
            } else {
                String::new()
            }
        };
        let extra = usize::from(code);
        if wants("table") {
            add(
                "table",
                "t.table_schema",
                format!(
                    "SELECT t.table_schema, NULL, t.table_name, NULL, NOT (LOWER(t.table_name) LIKE ?) \
                     FROM information_schema.tables t WHERE t.table_type = 'BASE TABLE' \
                     AND (LOWER(t.table_name) LIKE ?{}) AND {{schemas}} ORDER BY 1, 3",
                    or_code("t.table_comment")
                ),
                2 + extra,
            );
        }
        if wants("view") {
            add(
                "view",
                "v.table_schema",
                format!(
                    "SELECT v.table_schema, NULL, v.table_name, NULL, NOT (LOWER(v.table_name) LIKE ?) \
                     FROM information_schema.views v WHERE (LOWER(v.table_name) LIKE ?{}) \
                     AND {{schemas}} ORDER BY 1, 3",
                    or_code("v.view_definition")
                ),
                2 + extra,
            );
        }
        if wants("column") {
            add(
                "column",
                "c.table_schema",
                format!(
                    "SELECT c.table_schema, c.table_name, c.column_name, NULL, NOT (LOWER(c.column_name) LIKE ?) \
                     FROM information_schema.columns c WHERE (LOWER(c.column_name) LIKE ?{}) \
                     AND {{schemas}} ORDER BY 1, 2, 3",
                    or_code("c.column_comment")
                ),
                2 + extra,
            );
        }
        if wants("index") {
            add(
                "index",
                "s.table_schema",
                "SELECT DISTINCT s.table_schema, s.table_name, s.index_name, NULL, 0 \
                 FROM information_schema.statistics s WHERE LOWER(s.index_name) LIKE ? \
                 AND {schemas} ORDER BY 1, 3"
                    .into(),
                1,
            );
        }
        if wants("function") {
            add(
                "function",
                "r.routine_schema",
                format!(
                    "SELECT r.routine_schema, NULL, r.routine_name, r.routine_type, NOT (LOWER(r.routine_name) LIKE ?) \
                     FROM information_schema.routines r WHERE (LOWER(r.routine_name) LIKE ?{}) \
                     AND {{schemas}} ORDER BY 1, 3",
                    or_code("r.routine_definition")
                ),
                2 + extra,
            );
        }
        if wants("constraint") {
            add(
                "constraint",
                "k.table_schema",
                "SELECT k.table_schema, k.table_name, k.constraint_name, NULL, 0 \
                 FROM information_schema.table_constraints k \
                 WHERE LOWER(k.constraint_name) LIKE ? AND {schemas} ORDER BY 1, 3"
                    .into(),
                1,
            );
        }
        queries
    }

    fn path(
        &self,
        kind: &str,
        schema: Option<&str>,
        table: Option<&str>,
        name: &str,
        identity: Option<&str>,
    ) -> Vec<String> {
        let folder = match (kind, identity) {
            ("view", _) => "views",
            ("function", Some("PROCEDURE")) => "procedures",
            ("function", _) => "functions",
            _ => "tables",
        };
        let object = match kind {
            "table" | "view" | "function" => name,
            _ => table.unwrap_or(name),
        };
        vec![
            "databases".into(),
            schema.unwrap_or_default().into(),
            folder.into(),
            object.into(),
        ]
    }

    fn text_of(&self, column: &str, kind: &str) -> Option<String> {
        (!matches!(kind, "binary" | "spatial")).then(|| format!("CAST({column} AS CHAR)"))
    }
}
