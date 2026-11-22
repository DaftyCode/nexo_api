//! Types between engines: a table of cases, and the `CREATE TABLE` of each target.
use crate::sql::{Dialect, SourceColumn, convert, create_table};

fn column(name: &str, kind: &str, type_name: &str) -> SourceColumn {
    SourceColumn {
        name: name.into(),
        kind: kind.into(),
        type_name: type_name.into(),
        nullable: None,
    }
}

#[test]
fn each_kind_gets_the_closest_type_and_text_says_so() {
    use Dialect::{MySql, PostgreSql, Sqlite, TSql};
    let cases = [
        // kind, source type, target, expected type, as text
        ("integer", "int4", MySql, "INT", false),
        ("integer", "int8", MySql, "BIGINT", false),
        ("integer", "int2", TSql, "smallint", false),
        ("integer", "bigint", Sqlite, "INTEGER", false),
        ("decimal", "numeric(10,2)", MySql, "DECIMAL(10,2)", false),
        ("decimal", "numeric", MySql, "DECIMAL(65,30)", false),
        (
            "decimal",
            "decimal(12,2)",
            PostgreSql,
            "numeric(12,2)",
            false,
        ),
        ("float", "float4", MySql, "FLOAT", false),
        ("float", "float8", TSql, "float", false),
        ("boolean", "bool", MySql, "BOOLEAN", false),
        ("boolean", "bit", PostgreSql, "boolean", false),
        ("date", "date", Sqlite, "TEXT", false),
        ("timestamp", "timestamp", MySql, "DATETIME(6)", false),
        ("timestamptz", "timestamptz", TSql, "datetimeoffset", false),
        ("text", "varchar(20)", MySql, "VARCHAR(20)", false),
        ("text", "text", MySql, "LONGTEXT", false),
        ("text", "nvarchar(max)", PostgreSql, "text", false),
        (
            "text",
            "character varying(5000)",
            TSql,
            "nvarchar(max)",
            false,
        ),
        ("binary", "bytea", MySql, "LONGBLOB", false),
        ("json", "jsonb", MySql, "JSON", false),
        ("json", "json", TSql, "nvarchar(max)", true),
        ("uuid", "uuid", MySql, "CHAR(36)", true),
        ("uuid", "uniqueidentifier", PostgreSql, "uuid", false),
        ("xml", "xml", MySql, "LONGTEXT", true),
        ("interval", "interval", MySql, "LONGTEXT", true),
        ("array", "_int4", MySql, "LONGTEXT", true),
        ("spatial", "geometry", TSql, "nvarchar(max)", true),
        // SQLite keeps everything as text happily: nothing to warn about.
        ("interval", "interval", Sqlite, "TEXT", false),
    ];
    for (kind, source, to, expected, text) in cases {
        // From another engine than every target.
        let converted = convert(&column("c", kind, source), Dialect::Ansi, to);
        assert_eq!(
            (converted.sql_type.as_str(), converted.as_text),
            (expected, text),
            "{kind} {source} to {to:?}"
        );
    }
    // CQL has its own names, and text for what it has no type for.
    for (kind, source, expected, text) in [
        ("integer", "int8", "bigint", false),
        ("integer", "tinyint", "tinyint", false),
        ("float", "real", "float", false),
        ("timestamptz", "timestamptz", "timestamp", false),
        ("binary", "bytea", "blob", false),
        ("json", "jsonb", "text", true),
    ] {
        let converted = convert(&column("c", kind, source), Dialect::Ansi, Dialect::Cql);
        assert_eq!(
            (converted.sql_type.as_str(), converted.as_text),
            (expected, text),
            "{kind} {source}"
        );
    }
    // The same engine keeps the type as written.
    let same = convert(
        &column("c", "array", "integer[]"),
        Dialect::PostgreSql,
        Dialect::PostgreSql,
    );
    assert_eq!((same.sql_type.as_str(), same.as_text), ("integer[]", false));
}

#[test]
fn creates_the_table_in_the_target_engine_with_its_quotes() {
    let mut id = column("id", "integer", "int4");
    id.nullable = Some(false);
    let columns = [id, column("odd]name", "text", "varchar(10)")];
    let (sql, converted) = create_table(
        Dialect::TSql,
        Some("dbo"),
        "copied",
        &columns,
        Dialect::PostgreSql,
    );
    assert_eq!(
        sql,
        "CREATE TABLE [dbo].[copied] (\n  [id] int NOT NULL,\n  [odd]]name] nvarchar(10)\n)"
    );
    assert_eq!(converted[0].from, "int4");
    let (sql, _) = create_table(Dialect::MySql, None, "t`x", &columns, Dialect::PostgreSql);
    assert!(sql.starts_with("CREATE TABLE `t``x` (\n  `id` INT NOT NULL"));
}
