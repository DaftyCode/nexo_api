//! Column types from one engine to another, for copying a table to another connection or
//! creating one from a file: the closest type each engine has, and text (said so) for what
//! has none. The same engine keeps the type as it was written.
use super::Dialect;

/// A column as a driver describes it: its name, the kind of its values (`integer`,
/// `decimal`, `timestamptz`…) and its type as the engine writes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceColumn {
    pub name: String,
    pub kind: String,
    pub type_name: String,
    pub nullable: Option<bool>,
}

/// The type a column gets in the target engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Converted {
    pub name: String,
    pub from: String,
    pub sql_type: String,
    /// The target has no such type: its values are kept as text.
    pub as_text: bool,
}

/// `(10,2)` of `numeric(10,2)`: the numbers inside the type's parentheses.
fn sizes(type_name: &str) -> Vec<u32> {
    let Some(open) = type_name.find('(') else {
        return Vec::new();
    };
    let close = type_name[open..]
        .find(')')
        .map_or(type_name.len(), |at| open + at);
    type_name[open + 1..close]
        .split(',')
        .filter_map(|part| part.trim().parse().ok())
        .collect()
}

fn text_type(to: Dialect, length: Option<u32>) -> String {
    match (to, length) {
        (Dialect::PostgreSql, Some(length)) => format!("varchar({length})"),
        (Dialect::PostgreSql, None) => "text".into(),
        (Dialect::MySql, Some(length)) if length <= 16_383 => format!("VARCHAR({length})"),
        (Dialect::MySql, _) => "LONGTEXT".into(),
        (Dialect::TSql, Some(length)) if length <= 4_000 => format!("nvarchar({length})"),
        (Dialect::TSql, _) => "nvarchar(max)".into(),
        (Dialect::PlSql, Some(length)) if length <= 4_000 => format!("VARCHAR2({length} CHAR)"),
        (Dialect::PlSql, _) => "CLOB".into(),
        (Dialect::Sqlite | Dialect::Ansi, _) => "TEXT".into(),
    }
}

/// The type of `column` in `to`, written for that engine.
pub fn convert(column: &SourceColumn, from: Dialect, to: Dialect) -> Converted {
    let lower = column.type_name.to_ascii_lowercase();
    let same = from == to && !column.type_name.trim().is_empty();
    let (sql_type, as_text) = if same {
        (column.type_name.clone(), false)
    } else {
        target(&column.kind, &lower, to)
    };
    Converted {
        name: column.name.clone(),
        from: column.type_name.clone(),
        sql_type,
        as_text,
    }
}

fn target(kind: &str, lower: &str, to: Dialect) -> (String, bool) {
    use Dialect::{Ansi, MySql, PlSql, PostgreSql, Sqlite, TSql};
    let pick = |postgres: &str, mysql: &str, tsql: &str, sqlite: &str| -> String {
        match to {
            PostgreSql => postgres,
            MySql => mysql,
            TSql => tsql,
            PlSql | Sqlite | Ansi => sqlite,
        }
        .to_owned()
    };
    let numbers = sizes(lower);
    let as_text = |to_text: bool| (text_type(to, None), to_text && to != Sqlite);
    match kind {
        "integer" => {
            let small = lower.contains("small") || lower.contains("int2") || lower.contains("tiny");
            let big = lower.contains("big") || lower.contains("int8") || lower.contains("long");
            let found = match (small, big) {
                (true, _) => pick("smallint", "SMALLINT", "smallint", "INTEGER"),
                (_, true) => pick("bigint", "BIGINT", "bigint", "INTEGER"),
                _ => pick("integer", "INT", "int", "INTEGER"),
            };
            (
                if to == PlSql {
                    "NUMBER(19)".into()
                } else {
                    found
                },
                false,
            )
        }
        "decimal" => match (numbers.first(), numbers.get(1)) {
            (Some(&precision), scale) if precision <= 38 || to == PostgreSql => {
                let scale = scale.copied().unwrap_or(0);
                let typed = pick("numeric", "DECIMAL", "decimal", "NUMERIC");
                (format!("{typed}({precision},{scale})"), false)
            }
            _ => (
                pick("numeric", "DECIMAL(65,30)", "decimal(38,10)", "NUMERIC"),
                false,
            ),
        },
        "float" => {
            let single = lower.contains("real") || lower.contains("float4");
            if single {
                (pick("real", "FLOAT", "real", "REAL"), false)
            } else {
                (pick("double precision", "DOUBLE", "float", "REAL"), false)
            }
        }
        "boolean" => (pick("boolean", "BOOLEAN", "bit", "INTEGER"), false),
        "date" => (pick("date", "DATE", "date", "TEXT"), false),
        "time" => (pick("time", "TIME(6)", "time", "TEXT"), false),
        "timestamp" => (pick("timestamp", "DATETIME(6)", "datetime2", "TEXT"), false),
        "timestamptz" => (
            pick("timestamptz", "DATETIME(6)", "datetimeoffset", "TEXT"),
            false,
        ),
        "binary" => (pick("bytea", "LONGBLOB", "varbinary(max)", "BLOB"), false),
        "json" => match to {
            PostgreSql => ("jsonb".into(), false),
            MySql => ("JSON".into(), false),
            _ => as_text(true),
        },
        "xml" => match to {
            PostgreSql | TSql => ("xml".into(), false),
            _ => as_text(true),
        },
        "uuid" => match to {
            PostgreSql => ("uuid".into(), false),
            TSql => ("uniqueidentifier".into(), false),
            MySql => ("CHAR(36)".into(), true),
            _ => as_text(true),
        },
        "text" => (text_type(to, numbers.first().copied()), false),
        // Intervals, arrays, geometries and what has no kind: their text.
        _ => as_text(true),
    }
}

/// `"name"`, `` `name` `` or `[name]`, as the engine quotes a name.
pub fn quote(name: &str, dialect: Dialect) -> String {
    match dialect {
        Dialect::MySql => format!("`{}`", name.replace('`', "``")),
        Dialect::TSql => format!("[{}]", name.replace(']', "]]")),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

/// `CREATE TABLE` of `columns` in `to`, and what each column became.
pub fn create_table(
    to: Dialect,
    schema: Option<&str>,
    table: &str,
    columns: &[SourceColumn],
    from: Dialect,
) -> (String, Vec<Converted>) {
    let converted: Vec<Converted> = columns
        .iter()
        .map(|column| convert(column, from, to))
        .collect();
    let name = match schema.filter(|schema| !schema.is_empty()) {
        Some(schema) => format!("{}.{}", quote(schema, to), quote(table, to)),
        None => quote(table, to),
    };
    let lines: Vec<String> = converted
        .iter()
        .zip(columns)
        .map(|(column, source)| {
            let null = if source.nullable == Some(false) {
                " NOT NULL"
            } else {
                ""
            };
            format!("  {} {}{null}", quote(&column.name, to), column.sql_type)
        })
        .collect();
    (
        format!("CREATE TABLE {name} (\n{}\n)", lines.join(",\n")),
        converted,
    )
}
