use super::*;
use serde_json::json;

fn options(source: Dialect, target: Dialect) -> Options {
    Options {
        ignore_comments: false,
        ignore_column_order: true,
        ignore_constraint_names: false,
        source,
        target,
    }
}

fn orders() -> Value {
    json!({
        "schema": "shop", "name": "orders",
        "columns": [
            {"name": "id", "typeName": "integer", "nullable": false, "identity": true},
            {"name": "status", "typeName": "varchar(20)", "nullable": false, "default": "'new'::character varying"},
            {"name": "total", "typeName": "numeric(10,2)", "nullable": true, "default": "0"},
            {"name": "placed", "typeName": "timestamp with time zone", "nullable": true},
        ],
        "primaryKey": {"name": "orders_pkey", "columns": ["id"]},
        "uniques": [], "checks": [{"name": "total_positive", "expression": "(total >= (0)::numeric)"}],
        "foreignKeys": [],
        "indexes": [{"name": "orders_status", "columns": ["status"], "unique": false, "method": "btree"}],
    })
}

fn found(differences: &[Difference]) -> Vec<(Part, String, Status, Vec<&'static str>)> {
    differences
        .iter()
        .map(|d| (d.part, d.name.clone(), d.status, d.fields.clone()))
        .collect()
}

#[test]
fn tables_alike_have_no_differences_and_each_change_is_found_where_it_is() {
    let same = options(Dialect::PostgreSql, Dialect::PostgreSql);
    assert!(compare_tables(&orders(), &orders(), &same).is_empty());
    let mut changed = orders();
    changed["columns"][1]["typeName"] = json!("varchar(30)");
    changed["columns"][2]["default"] = json!("('0')");
    changed["columns"][3]["nullable"] = json!(false);
    changed["columns"]
        .as_array_mut()
        .unwrap()
        .push(json!({"name": "note", "typeName": "text", "nullable": true}));
    changed["indexes"] = json!([]);
    changed["checks"][0]["expression"] = json!("total > 0");
    changed["primaryKey"]["name"] = json!("pk_orders");
    assert_eq!(
        found(&compare_tables(&orders(), &changed, &same)),
        [
            (
                Part::Column,
                "status".into(),
                Status::Different,
                vec!["type"]
            ),
            (
                Part::Column,
                "placed".into(),
                Status::Different,
                vec!["nullable"]
            ),
            (Part::Column, "note".into(), Status::OnlyTarget, vec![]),
            (
                Part::PrimaryKey,
                "orders_pkey".into(),
                Status::Different,
                vec!["name"]
            ),
            (
                Part::Check,
                "total_positive".into(),
                Status::Different,
                vec!["expression"]
            ),
            (
                Part::Index,
                "orders_status".into(),
                Status::OnlySource,
                vec![]
            ),
        ]
    );
    // Generated names left out: the key and the index are paired by what they hold.
    let mut renamed = orders();
    renamed["primaryKey"]["name"] = json!("pk_orders");
    renamed["indexes"][0]["name"] = json!("ix_1");
    let unnamed = Options {
        ignore_constraint_names: true,
        ..same
    };
    assert!(compare_tables(&orders(), &renamed, &unnamed).is_empty());
    let mut reordered = orders();
    reordered["columns"].as_array_mut().unwrap().swap(0, 1);
    reordered["comment"] = json!("Orders");
    let strict = Options {
        ignore_column_order: false,
        ..same
    };
    assert_eq!(
        found(&compare_tables(&orders(), &reordered, &strict)),
        [
            (
                Part::Table,
                String::new(),
                Status::Different,
                vec!["columnOrder"]
            ),
            (
                Part::Table,
                String::new(),
                Status::Different,
                vec!["comment"]
            ),
        ]
    );
    let quiet = Options {
        ignore_comments: true,
        ..same
    };
    assert!(compare_tables(&orders(), &reordered, &quiet).is_empty());
}

#[test]
fn a_copy_in_another_engine_has_equivalent_types_and_no_false_differences() {
    // The table as DB-17 copies it to MySQL: converted types, upper case names.
    let copy = json!({
        "name": "Orders",
        "columns": [
            {"name": "ID", "typeName": "int", "nullable": false, "identity": true},
            {"name": "status", "typeName": "varchar(20)", "nullable": false, "default": "new"},
            {"name": "total", "typeName": "decimal(10,2)", "nullable": true, "default": "0.00"},
            {"name": "placed", "typeName": "datetime(6)", "nullable": true},
        ],
        "primaryKey": {"name": "PRIMARY", "columns": ["ID"]},
        "checks": [{"name": "total_positive", "expression": "(`total` >= 0)"}],
        "indexes": [{"name": "orders_status", "columns": ["status"], "unique": false, "method": "BTREE"}],
    });
    let between = Options {
        ignore_constraint_names: true,
        ..options(Dialect::PostgreSql, Dialect::MySql)
    };
    let differences = compare_tables(&orders(), &copy, &between);
    let statuses: Vec<_> = differences
        .iter()
        .map(|d| (d.name.as_str(), d.status, d.fields.clone()))
        .collect();
    assert_eq!(
        statuses,
        [
            ("id", Status::Equivalent, vec![]),
            ("status", Status::Different, vec!["default"]),
            ("total", Status::Equivalent, vec![]),
            ("placed", Status::Equivalent, vec![]),
            ("total_positive", Status::Different, vec!["expression"]),
        ]
    );
    for (source, target, status) in [
        ("uuid", "CHAR(36)", Status::Equivalent),
        ("boolean", "tinyint(1)", Status::Equivalent),
        ("jsonb", "json", Status::Equivalent),
        ("text", "longtext", Status::Equivalent),
        ("varchar(50)", "varchar(20)", Status::Different),
        ("character varying(40)", "longtext", Status::Equivalent),
        ("numeric(10,2)", "decimal(65,30)", Status::Equivalent),
        ("numeric(10,2)", "decimal(10,1)", Status::Different),
        ("numeric(10,2)", "decimal(9,2)", Status::Different),
        ("integer", "varchar(10)", Status::Different),
        ("point", "int", Status::Different),
    ] {
        assert_eq!(
            type_status(source, target, Dialect::PostgreSql, Dialect::MySql),
            status,
            "{source} {target}"
        );
    }
    assert_eq!(
        type_status("int4", "INT4", Dialect::PostgreSql, Dialect::PostgreSql),
        Status::Equal
    );
    for (source, target, status) in [
        ("character varying(40)", "nvarchar(max)", Status::Equivalent),
        ("text", "nvarchar(max)", Status::Equivalent),
        ("numeric(10,2)", "decimal(38,10)", Status::Equivalent),
    ] {
        assert_eq!(
            type_status(source, target, Dialect::PostgreSql, Dialect::TSql),
            status,
            "{source} {target}"
        );
    }
    assert_eq!(
        type_status(
            "nvarchar(max)",
            "varchar(40)",
            Dialect::TSql,
            Dialect::PostgreSql
        ),
        Status::Different
    );
    for (source, target, status) in [
        ("int(11)", "int", Status::Equal),
        ("bigint(20) unsigned", "BIGINT UNSIGNED", Status::Equal),
        ("tinyint(1)", "tinyint(4)", Status::Different),
        ("int(11)", "bigint", Status::Different),
    ] {
        assert_eq!(
            type_status(source, target, Dialect::MySql, Dialect::MySql),
            status,
            "{source} {target}"
        );
    }
    assert_eq!(kind_of("interval"), "other");
    assert_eq!(kind_of("bigint unsigned"), "integer");
}

mod values;
