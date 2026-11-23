//! What needs no server: Hive's columns and rows read from Thrift, its errors, and the
//! commands the driver never sends. The driver against HiveServer2 is tested in `tests/`.
use crate::{
    catalog::quote,
    rows::{columns, rows, type_name},
    session::{check, failure},
    statements::refuse_server_commands,
    thrift::{Builder, Thrift},
};
use nexo_driver_sdk::{ErrorCode, Value, ValueKind};

/// A `TColumnDesc` of a primitive type, with its qualifiers.
fn column(name: &str, position: i32, id: i32, qualifiers: &[(&str, i32)]) -> Thrift {
    let mut primitive = Builder::new().set(1, Thrift::I32(id));
    if !qualifiers.is_empty() {
        let entries = qualifiers
            .iter()
            .map(|(key, value)| {
                (
                    Thrift::text(key),
                    Builder::new().set(1, Thrift::I32(*value)).build(),
                )
            })
            .collect();
        let map = Builder::new().set(1, Thrift::Map(11, 12, entries)).build();
        primitive = primitive.set(2, map);
    }
    let entry = Builder::new().set(1, primitive.build()).build();
    let desc = Builder::new().set(1, Thrift::List(12, vec![entry])).build();
    Builder::new()
        .set(1, Thrift::text(name))
        .set(2, desc)
        .set(3, Thrift::I32(position))
        .build()
}

#[test]
fn columns_keep_their_type_and_order() {
    let array = Builder::new()
        .set(2, Builder::new().set(1, Thrift::I32(0)).build())
        .build();
    let tags = Builder::new()
        .set(1, Thrift::text("tags"))
        .set(
            2,
            Builder::new().set(1, Thrift::List(12, vec![array])).build(),
        )
        .set(3, Thrift::I32(4))
        .build();
    let schema = Builder::new()
        .set(
            1,
            Thrift::List(
                12,
                vec![
                    column("price", 2, 15, &[("precision", 10), ("scale", 2)]),
                    column("id", 1, 3, &[]),
                    column("code", 3, 18, &[("characterMaximumLength", 20)]),
                    tags,
                ],
            ),
        )
        .build();
    let found = columns(&schema);
    let named: Vec<_> = found
        .iter()
        .map(|column| (column.name.as_str(), column.type_name.as_str(), column.kind))
        .collect();
    assert_eq!(
        named,
        [
            ("id", "int", ValueKind::Integer),
            ("price", "decimal(10,2)", ValueKind::Decimal),
            ("code", "varchar(20)", ValueKind::Text),
            ("tags", "array", ValueKind::Json),
        ]
    );
    assert_eq!(type_name(22), "timestamp with local time zone");
    assert_eq!(type_name(99), "unknown");
}

#[test]
fn rows_are_read_from_columns_with_their_nulls() {
    let cols = columns(
        &Builder::new()
            .set(
                1,
                Thrift::List(
                    12,
                    vec![
                        column("id", 1, 4, &[]),
                        column("at", 2, 17, &[]),
                        column("raw", 3, 9, &[]),
                        column("ok", 4, 0, &[]),
                        column("ratio", 5, 6, &[]),
                    ],
                ),
            )
            .build(),
    );
    let typed = |field: i16, values: Vec<Thrift>, item: u8, nulls: &[u8]| {
        Builder::new()
            .set(
                field,
                Builder::new()
                    .set(1, Thrift::List(item, values))
                    .set(2, Thrift::Bytes(nulls.to_vec()))
                    .build(),
            )
            .build()
    };
    let set = Builder::new()
        .set(1, Thrift::I64(0))
        .set(2, Thrift::List(12, Vec::new()))
        .set(
            3,
            Thrift::List(
                12,
                vec![
                    typed(5, vec![Thrift::I64(7), Thrift::I64(0)], 10, &[0b10]),
                    typed(
                        7,
                        vec![Thrift::text("2024-01-02"), Thrift::text("")],
                        11,
                        &[0b10],
                    ),
                    typed(
                        8,
                        vec![Thrift::Bytes(b"AB".to_vec()), Thrift::Bytes(Vec::new())],
                        11,
                        &[0],
                    ),
                    typed(1, vec![Thrift::Bool(true), Thrift::Bool(false)], 2, &[0]),
                    typed(6, vec![Thrift::Double(0.5), Thrift::Double(1.5)], 4, &[0]),
                ],
            ),
        )
        .build();
    let found = rows(&set, &cols);
    assert_eq!(
        found[0],
        [
            Value::Integer(7),
            Value::typed(ValueKind::Date, "2024-01-02"),
            Value::bytes(b"AB"),
            Value::Bool(true),
            Value::Float(0.5),
        ]
    );
    assert_eq!(found[1][0], Value::Null);
    assert_eq!(found[1][1], Value::Null);
    assert!(rows(&Builder::new().build(), &cols).is_empty());
}

#[test]
fn hive_errors_say_what_failed() {
    let status = |code: i32, message: Option<&str>, state: Option<&str>| {
        let mut status = Builder::new().set(1, Thrift::I32(code));
        if let Some(message) = message {
            status = status.set(5, Thrift::text(message));
        }
        if let Some(state) = state {
            status = status.set(3, Thrift::text(state));
        }
        Builder::new().set(1, status.build()).build()
    };
    assert!(check(&status(0, None, None)).is_ok());
    assert!(check(&status(2, None, None)).is_ok());
    let syntax = check(&status(
        3,
        Some("Error while compiling statement: FAILED: ParseException line 1:7\nmore"),
        Some("42000"),
    ))
    .unwrap_err();
    assert_eq!(syntax.code, ErrorCode::Syntax);
    assert!(!syntax.message.contains("more"));
    let missing = check(&status(4, None, None)).unwrap_err();
    assert_eq!(missing.message, "HiveServer2 answered with an error");
    assert_eq!(
        failure("Permission denied: user=ana", None).code,
        ErrorCode::Permission
    );
    assert_eq!(failure("Table not found", None).code, ErrorCode::Invalid);
}

#[test]
fn commands_that_reach_the_server_files_are_never_sent() {
    for sql in [
        "ADD JAR hdfs:///x.jar",
        "add file /etc/passwd",
        "LIST JARS",
        "DELETE ARCHIVE a.zip",
        "dfs -ls /",
        "!ls",
        "RELOAD",
        "COMPILE `x` AS GROOVY NAMED y",
    ] {
        assert!(refuse_server_commands(sql).is_err(), "{sql}");
    }
    for sql in [
        "SELECT 1",
        "DELETE FROM t WHERE id = 1",
        "SET hive.exec.mode=local",
        "ADD COLUMNS",
    ] {
        assert!(refuse_server_commands(sql).is_ok(), "{sql}");
    }
    assert_eq!(quote("we`ird"), "`we``ird`");
}
