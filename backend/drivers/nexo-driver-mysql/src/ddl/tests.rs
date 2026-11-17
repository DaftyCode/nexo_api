//! The DDL MySQL and MariaDB get for each change, and how a default reads back.
use super::{default_of, writer::MysqlWriter};
use nexo_driver_sdk::ddl::{ColumnModel, DdlPlanParams, KeyModel, TableModel, plan};

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
        schema: Some("shop".into()),
        name: "items".into(),
        original: "items".into(),
        columns: vec![
            ColumnModel {
                identity: true,
                ..column("id", "int", false)
            },
            column("label", "varchar(20)", true),
        ],
        primary_key: Some(KeyModel {
            name: String::new(),
            columns: vec!["id".into()],
        }),
        ..TableModel::default()
    }
}
fn params(original: Option<TableModel>, target: Option<TableModel>) -> DdlPlanParams {
    DdlPlanParams {
        connection: "c".into(),
        original,
        target,
        cascade: false,
    }
}

#[test]
fn creates_and_changes_a_table_with_whole_declarations() {
    let mut new = items();
    new.original.clear();
    new.options.insert("engine".into(), "InnoDB".into());
    new.comment = Some("what we sell".into());
    let created = plan(&MysqlWriter, &params(None, Some(new))).unwrap();
    assert_eq!(
        created.statements,
        [
            "CREATE TABLE `shop`.`items` (\n  `id` int NOT NULL AUTO_INCREMENT,\n  `label` varchar(20),\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB COMMENT='what we sell'"
        ]
    );
    assert!(!created.transactional);
    let mut after = items();
    after.columns[1].type_name = "varchar(80)".into();
    after.columns[1].default = Some("'none'".into());
    after.columns[1].comment = Some("its name".into());
    after.columns.push(ColumnModel {
        original: String::new(),
        ..column("price", "decimal(10,2)", true)
    });
    let changed = plan(&MysqlWriter, &params(Some(items()), Some(after))).unwrap();
    assert_eq!(
        changed.statements,
        [
            "ALTER TABLE `shop`.`items` MODIFY COLUMN `label` varchar(80) DEFAULT 'none' COMMENT 'its name'",
            "ALTER TABLE `shop`.`items` ADD COLUMN `price` decimal(10,2)",
        ]
    );
    assert!(changed.warnings.iter().any(|w| w.contains("half way")));
}

#[test]
fn defaults_read_back_as_sql() {
    assert_eq!(
        default_of(Some("new".into()), "varchar(5)", "", false).as_deref(),
        Some("'new'")
    );
    assert_eq!(
        default_of(Some("0".into()), "int", "", false).as_deref(),
        Some("0")
    );
    assert_eq!(
        default_of(
            Some("CURRENT_TIMESTAMP".into()),
            "timestamp",
            "DEFAULT_GENERATED",
            false
        )
        .as_deref(),
        Some("CURRENT_TIMESTAMP")
    );
    assert_eq!(
        default_of(Some("'new'".into()), "varchar(5)", "", true).as_deref(),
        Some("'new'")
    );
    assert_eq!(
        default_of(Some("NULL".into()), "varchar(5)", "", true),
        None
    );
    assert_eq!(default_of(None, "int", "", false), None);
}
