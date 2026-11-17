//! Searching PostgreSQL: its objects in `pg_catalog` (and the code of views and routines,
//! and comments), and the text of a column as `::text`.
use nexo_driver_sdk::{
    Value,
    search::{CatalogQuery, SearchCatalog, SearchParams},
};

/// Schemas of the system, never searched.
const SYSTEM: &str = "n.nspname NOT IN ('pg_catalog', 'information_schema') \
    AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'";

pub struct PgSearch {
    pub database: String,
}

/// `AND n.nspname IN ($2, $3…)` for the schemas asked for, and their values.
fn schemas(params: &SearchParams) -> (String, Vec<Value>) {
    if params.schemas.is_empty() {
        return (String::new(), Vec::new());
    }
    let marks: Vec<String> = (0..params.schemas.len())
        .map(|at| format!("${}", at + 2))
        .collect();
    let values = params
        .schemas
        .iter()
        .map(|schema| Value::Text(schema.clone()))
        .collect();
    (format!(" AND n.nspname IN ({})", marks.join(", ")), values)
}

impl SearchCatalog for PgSearch {
    fn queries(&self, pattern: &str, params: &SearchParams) -> Vec<CatalogQuery> {
        let wants = |kind: &str| params.kinds.is_empty() || params.kinds.iter().any(|k| k == kind);
        let (only, mut values) = schemas(params);
        values.insert(0, Value::Text(pattern.into()));
        let filter = format!("{SYSTEM}{only}");
        let named = |column: &str| format!("lower({column}) LIKE $1");
        let code = |source: &str| {
            if params.code {
                format!(" OR lower(coalesce({source}, '')) LIKE $1")
            } else {
                String::new()
            }
        };
        let comment =
            |oid: &str, catalog: &str| code(&format!("obj_description({oid}, '{catalog}')"));
        let mut queries = Vec::new();
        let mut add = |kind: &'static str, sql: String| {
            queries.push(CatalogQuery {
                kind,
                sql,
                params: values.clone(),
            })
        };
        if wants("table") {
            add(
                "table",
                format!(
                    "SELECT n.nspname, NULL, c.relname, c.relkind::text, NOT {} FROM pg_class c \
                 JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p', 'f') \
                 AND {filter} AND ({}{}) ORDER BY 1, 3",
                    named("c.relname"),
                    named("c.relname"),
                    comment("c.oid", "pg_class")
                ),
            );
        }
        if wants("view") {
            add(
                "view",
                format!(
                    "SELECT n.nspname, NULL, c.relname, c.relkind::text, NOT {} FROM pg_class c \
                 JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('v', 'm') \
                 AND {filter} AND ({}{}{}) ORDER BY 1, 3",
                    named("c.relname"),
                    named("c.relname"),
                    code("pg_get_viewdef(c.oid)"),
                    comment("c.oid", "pg_class")
                ),
            );
        }
        if wants("column") {
            add(
                "column",
                format!(
                    "SELECT n.nspname, c.relname, a.attname, c.relkind::text, NOT {} FROM pg_attribute a \
                 JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p', 'f', 'v', 'm') \
                 AND {filter} AND ({}{}) ORDER BY 1, 2, 3",
                    named("a.attname"),
                    named("a.attname"),
                    code("col_description(c.oid, a.attnum)")
                ),
            );
        }
        if wants("index") {
            add(
                "index",
                format!(
                    "SELECT n.nspname, t.relname, i.relname, t.relkind::text, false FROM pg_index x \
                 JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid \
                 JOIN pg_namespace n ON n.oid = i.relnamespace WHERE {filter} AND {} ORDER BY 1, 3",
                    named("i.relname")
                ),
            );
        }
        if wants("function") {
            add(
                "function",
                format!(
                    "SELECT n.nspname, NULL, p.proname, p.oid::text || ':' || p.prokind::text, NOT {} \
                 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
                 WHERE {filter} AND ({}{}{}) ORDER BY 1, 3",
                    named("p.proname"),
                    named("p.proname"),
                    code("p.prosrc"),
                    comment("p.oid", "pg_proc")
                ),
            );
        }
        if wants("constraint") {
            add(
                "constraint",
                format!(
                    "SELECT n.nspname, t.relname, c.conname, t.relkind::text, false FROM pg_constraint c \
                 JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace \
                 WHERE {filter} AND {} ORDER BY 1, 3",
                    named("c.conname")
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
        let folder = |relkind: Option<&str>| match relkind {
            Some("v") => "views",
            Some("m") => "materialized-views",
            Some("f") => "foreign-tables",
            _ => "tables",
        };
        let base = vec![
            self.database.clone(),
            "schemas".into(),
            schema.unwrap_or("public").to_owned(),
        ];
        let tail: Vec<String> = match kind {
            "table" | "view" => vec![folder(identity).into(), name.into()],
            "function" => {
                let (oid, prokind) = identity
                    .and_then(|id| id.split_once(':'))
                    .unwrap_or(("", "f"));
                let folder = match prokind {
                    "p" => "procedures",
                    "a" => "aggregates",
                    _ => "functions",
                };
                vec![folder.into(), oid.into()]
            }
            // A column, an index or a constraint opens its table.
            _ => vec![folder(identity).into(), table.unwrap_or(name).into()],
        };
        base.into_iter().chain(tail).collect()
    }

    fn text_of(&self, column: &str, kind: &str) -> Option<String> {
        (!matches!(kind, "binary" | "spatial")).then(|| format!("{column}::text"))
    }
}
