//! Searching SQL Server: the objects of the current database in `sys` (and the code of views
//! and routines), and the text of a column as `nvarchar(max)`.
use nexo_driver_sdk::{
    Value,
    search::{CatalogQuery, SearchCatalog, SearchParams},
};

pub struct SqlServerSearch;

/// `0` or `1` as SQL Server's `bit`: whether a hit was found in code, not by name.
fn in_code(name: &str) -> String {
    format!("CAST(CASE WHEN LOWER({name}) LIKE @P1 THEN 0 ELSE 1 END AS bit)")
}

impl SearchCatalog for SqlServerSearch {
    fn queries(&self, pattern: &str, params: &SearchParams) -> Vec<CatalogQuery> {
        let wants = |kind: &str| params.kinds.is_empty() || params.kinds.iter().any(|k| k == kind);
        let mut values = vec![Value::Text(pattern.into())];
        values.extend(
            params
                .schemas
                .iter()
                .map(|schema| Value::Text(schema.clone())),
        );
        let only = if params.schemas.is_empty() {
            "s.name NOT IN ('sys', 'INFORMATION_SCHEMA')".to_owned()
        } else {
            let marks: Vec<String> = (0..params.schemas.len())
                .map(|at| format!("@P{}", at + 2))
                .collect();
            format!("s.name IN ({})", marks.join(", "))
        };
        let code = |object: &str| {
            if params.code {
                format!(" OR LOWER(COALESCE(OBJECT_DEFINITION({object}), '')) LIKE @P1")
            } else {
                String::new()
            }
        };
        // The database goes with every hit, for its place in the tree.
        let objects = |types: &str, extra: String| {
            format!(
                "SELECT s.name, NULL, o.name, DB_NAME() + '|' + RTRIM(o.type), {} FROM sys.objects o \
                 JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE o.type IN ({types}) \
                 AND {only} AND (LOWER(o.name) LIKE @P1{extra}) ORDER BY 1, 3",
                in_code("o.name")
            )
        };
        let mut queries = Vec::new();
        let mut add = |kind: &'static str, sql: String| {
            queries.push(CatalogQuery {
                kind,
                sql,
                params: values.clone(),
            })
        };
        if wants("table") {
            add("table", objects("'U'", String::new()));
        }
        if wants("view") {
            add("view", objects("'V'", code("o.object_id")));
        }
        if wants("column") {
            add(
                "column",
                format!(
                    "SELECT s.name, o.name, c.name, DB_NAME() + '|' + RTRIM(o.type), CAST(0 AS bit) \
                 FROM sys.columns c JOIN sys.objects o ON o.object_id = c.object_id \
                 JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE o.type IN ('U', 'V') \
                 AND {only} AND LOWER(c.name) LIKE @P1 ORDER BY 1, 2, 3"
                ),
            );
        }
        if wants("index") {
            add(
                "index",
                format!(
                    "SELECT s.name, o.name, i.name, DB_NAME() + '|' + RTRIM(o.type), CAST(0 AS bit) \
                 FROM sys.indexes i JOIN sys.objects o ON o.object_id = i.object_id \
                 JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE i.name IS NOT NULL \
                 AND o.type IN ('U', 'V') AND {only} AND LOWER(i.name) LIKE @P1 ORDER BY 1, 3"
                ),
            );
        }
        if wants("function") {
            add(
                "function",
                objects("'FN', 'IF', 'TF', 'P'", code("o.object_id")),
            );
        }
        if wants("constraint") {
            add(
                "constraint",
                format!(
                    "SELECT s.name, t.name, o.name, DB_NAME() + '|' + RTRIM(t.type), CAST(0 AS bit) \
                 FROM sys.objects o JOIN sys.objects t ON t.object_id = o.parent_object_id \
                 JOIN sys.schemas s ON s.schema_id = o.schema_id \
                 WHERE o.type IN ('PK', 'UQ', 'F', 'C', 'D') AND {only} AND LOWER(o.name) LIKE @P1 \
                 ORDER BY 1, 3"
                ),
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
        let (database, kind_code) = identity
            .and_then(|identity| identity.split_once('|'))
            .unwrap_or(("", "U"));
        let folder = match kind_code {
            "V" => "views",
            "P" => "procedures",
            "FN" | "IF" | "TF" => "functions",
            _ => "tables",
        };
        let object = match kind {
            "table" | "view" | "function" => name,
            _ => table.unwrap_or(name),
        };
        vec![
            "databases".into(),
            database.into(),
            "schemas".into(),
            schema.unwrap_or("dbo").into(),
            folder.into(),
            object.into(),
        ]
    }

    fn text_of(&self, column: &str, kind: &str) -> Option<String> {
        (!matches!(kind, "binary" | "spatial")).then(|| format!("CAST({column} AS nvarchar(max))"))
    }
}
