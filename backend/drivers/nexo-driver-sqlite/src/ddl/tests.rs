//! The DDL SQLite gets for each change: in place where SQLite can, else a rebuild.
use super::{checks_of, writer::SqliteWriter};
use nexo_driver_sdk::ddl::{ColumnModel, DdlPlanParams, TableModel, plan};

fn column(name: &str, type_name: &str, nullable: bool) -> ColumnModel {
    ColumnModel {
        name: name.into(),
        original: name.into(),
        type_name: type_name.into(),
        nullable,
        ..ColumnModel::default()
    }
}
fn items() -> TableModel {
    TableModel {
        name: "items".into(),
        original: "items".into(),
        columns: vec![
            ColumnModel {
                identity: true,
                ..column("id", "INTEGER", false)
            },
            column("label", "TEXT", true),
        ],
        ..TableModel::default()
    }
}
fn change(after: TableModel) -> nexo_driver_sdk::ddl::DdlPlan {
    plan(
        &SqliteWriter,
        &DdlPlanParams {
            connection: "c".into(),
            original: Some(items()),
            target: Some(after),
            cascade: false,
        },
    )
    .unwrap()
}

#[test]
fn adds_and_renames_in_place_and_rebuilds_for_a_new_type() {
    let mut added = items();
    added.columns[1].name = "title".into();
    added.columns.push(ColumnModel {
        original: String::new(),
        default: Some("0".into()),
        ..column("price", "REAL", false)
    });
    assert_eq!(
        change(added).statements,
        [
            "ALTER TABLE \"items\" RENAME COLUMN \"label\" TO \"title\"",
            "ALTER TABLE \"items\" ADD COLUMN \"price\" REAL NOT NULL DEFAULT 0",
        ]
    );
    let mut retyped = items();
    retyped.columns[1].type_name = "VARCHAR(20)".into();
    let rebuilt = change(retyped);
    assert_eq!(
        rebuilt.statements,
        [
            "CREATE TABLE \"items__nexo_new\" (\n  \"id\" INTEGER PRIMARY KEY AUTOINCREMENT,\n  \"label\" VARCHAR(20)\n)",
            "INSERT INTO \"items__nexo_new\" (\"id\", \"label\") SELECT \"id\", \"label\" FROM \"items\"",
            "DROP TABLE \"items\"",
            "ALTER TABLE \"items__nexo_new\" RENAME TO \"items\"",
        ]
    );
    assert!(
        rebuilt
            .warnings
            .iter()
            .any(|warning| warning.contains("created again"))
    );
}

#[test]
fn reads_the_checks_of_a_table() {
    let checks = checks_of(
        "CREATE TABLE t (a INT CHECK (a > 0), b TEXT, 'check (x)' TEXT, CONSTRAINT \"b_short\" CHECK (length(b) < (10)))",
    );
    assert_eq!(
        checks
            .iter()
            .map(|c| (c.name.as_str(), c.expression.as_str()))
            .collect::<Vec<_>>(),
        [("", "a > 0"), ("b_short", "length(b) < (10)")]
    );
}
