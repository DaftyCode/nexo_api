use super::*;

fn column(name: &str, kind: &str, key: Option<i64>, colocation: Option<i64>) -> TableColumn {
    TableColumn {
        name: name.into(),
        kind: kind.into(),
        nullable: key.is_none(),
        length: if kind == "STRING" { 20 } else { 0 },
        key,
        colocation,
        ..TableColumn::default()
    }
}

#[test]
fn types_are_written_as_ignite_sql_names_them() {
    let typed = |kind: &str, precision: i64, scale: i64, length: i64| {
        sql_type(&TableColumn {
            kind: kind.into(),
            precision,
            scale,
            length,
            ..TableColumn::default()
        })
    };
    assert_eq!(typed("INT32", 0, 0, 1), "INT");
    assert_eq!(typed("DECIMAL", 10, 2, 10), "DECIMAL(10, 2)");
    assert_eq!(typed("DECIMAL", 0, 0, 0), "DECIMAL");
    assert_eq!(typed("STRING", 0, 0, 100), "VARCHAR(100)");
    assert_eq!(typed("BYTE_ARRAY", 0, 0, 64), "VARBINARY(64)");
    assert_eq!(typed("TIME", 3, 0, 3), "TIME(3)");
    assert_eq!(typed("DATETIME", 6, 0, 6), "TIMESTAMP(6)");
    assert_eq!(
        typed("TIMESTAMP", 6, 0, 6),
        "TIMESTAMP(6) WITH LOCAL TIME ZONE"
    );
    for (kind, name) in [
        ("INT8", "TINYINT"),
        ("INT16", "SMALLINT"),
        ("INT64", "BIGINT"),
        ("FLOAT", "REAL"),
        ("DOUBLE", "DOUBLE"),
        ("UUID", "UUID"),
        ("PERIOD", "INTERVAL YEAR TO MONTH"),
        ("DURATION", "INTERVAL DAY TO SECOND"),
    ] {
        assert_eq!(typed(kind, 0, 0, 0), name);
    }
}

fn index(id: i64, name: &str, kind: &str, columns: &[(&str, &str)]) -> Index {
    Index {
        id,
        name: name.into(),
        kind: kind.into(),
        columns: columns
            .iter()
            .map(|(name, order)| ((*name).into(), (*order).into()))
            .collect(),
        ..Index::default()
    }
}

#[test]
fn a_table_is_rebuilt_with_its_key_colocation_zone_and_indexes() {
    let columns = [
        column("ID", "INT32", Some(0), None),
        column("REGION", "STRING", Some(1), Some(0)),
        column("NAME", "STRING", None, None),
    ];
    assert_eq!(key_columns(&columns), ["ID", "REGION"]);
    let primary = index(
        23,
        "ITEMS_PK",
        "HASH",
        &[("ID", "null"), ("REGION", "null")],
    );
    let table = Table {
        zone: "SHOP_ZONE".into(),
        storage: "default".into(),
        colocation: "REGION".into(),
        primary: Some(primary.clone()),
        indexes: vec![
            primary,
            index(
                24,
                "ITEMS_NAME",
                "SORTED",
                &[("NAME", "DESC_NULLS_FIRST"), ("ID", "ASC_NULLS_LAST")],
            ),
            index(25, "BY \"ODD\"", "HASH", &[("NAME", "null")]),
        ],
    };
    let path = ["SHOP".to_owned(), "ITEMS".to_owned()];
    assert_eq!(
        create(&path, &columns, &table),
        "CREATE TABLE \"SHOP\".\"ITEMS\" (\n    \"ID\" INT NOT NULL,\n    \"REGION\" VARCHAR(20) \
         NOT NULL,\n    \"NAME\" VARCHAR(20),\n    PRIMARY KEY USING HASH (\"ID\", \"REGION\")\n) \
         COLOCATE BY (\"REGION\") ZONE \"SHOP_ZONE\" STORAGE PROFILE 'default';\n\n\
         CREATE INDEX \"ITEMS_NAME\" ON \"SHOP\".\"ITEMS\" USING SORTED (\"NAME\" DESC, \"ID\" ASC);\
         \n\nCREATE INDEX \"BY \"\"ODD\"\"\" ON \"SHOP\".\"ITEMS\" USING HASH (\"NAME\");"
    );
}

#[test]
fn a_sorted_key_keeps_its_order_and_a_key_colocation_is_not_repeated() {
    let columns = [column("ID", "INT64", Some(0), Some(0))];
    let primary = index(5, "T_PK", "SORTED", &[("ID", "DESC_NULLS_LAST")]);
    let table = Table {
        primary: Some(primary.clone()),
        indexes: vec![primary],
        ..Table::default()
    };
    let path = ["PUBLIC".to_owned(), "T".to_owned()];
    assert_eq!(
        create(&path, &columns, &table),
        "CREATE TABLE \"PUBLIC\".\"T\" (\n    \"ID\" BIGINT NOT NULL,\n    PRIMARY KEY USING \
         SORTED (\"ID\" DESC NULLS LAST)\n);"
    );
    let row = index(1, "I", "HASH", &[]).row();
    assert_eq!(row[0], Value::Text("I".into()));
    assert_eq!(row[2], Value::Bool(false));
    let sorted = index(2, "S", "SORTED", &[("A", "ASC_NULLS_FIRST")]);
    assert_eq!(sorted.columns_sql(), "\"A\" ASC NULLS FIRST");
}
