use super::*;

/// Writes plain SQL; `in_place: false` makes every change of a column rebuild the table.
struct Plain {
    in_place: bool,
}
impl DdlWriter for Plain {
    fn table(&self, table: &TableModel) -> String {
        self.quote(&table.name)
    }
    fn quote(&self, name: &str) -> String {
        format!("\"{name}\"")
    }
    fn column(&self, _: &TableModel, column: &ColumnModel) -> String {
        let null = if column.nullable { "" } else { " NOT NULL" };
        format!("{} {}{null}", self.quote(&column.name), column.type_name)
    }
    fn create(&self, table: &TableModel) -> Vec<String> {
        let columns: Vec<String> = table
            .columns
            .iter()
            .map(|c| self.column(table, c))
            .collect();
        vec![format!(
            "CREATE TABLE {} ({})",
            self.table(table),
            columns.join(", ")
        )]
    }
    fn drop(&self, table: &TableModel, cascade: bool) -> Vec<String> {
        let cascade = if cascade { " CASCADE" } else { "" };
        vec![format!("DROP TABLE {}{cascade}", self.table(table))]
    }
    fn rename_table(&self, table: &TableModel, to: &str) -> Step {
        Step::one(format!(
            "RENAME {} TO {}",
            self.table(table),
            self.quote(to)
        ))
    }
    fn table_comment(&self, table: &TableModel, _: Option<&str>, after: Option<&str>) -> Step {
        Step::one(format!(
            "COMMENT {} {}",
            self.table(table),
            after.unwrap_or("NULL")
        ))
    }
    fn add_column(&self, table: &TableModel, column: &ColumnModel) -> Step {
        Step::one(format!("ADD {}", self.column(table, column)))
    }
    fn drop_column(&self, _: &TableModel, column: &str) -> Step {
        Step::one(format!("DROP COLUMN {column}"))
    }
    fn rename_column(&self, _: &TableModel, from: &str, to: &str) -> Step {
        Step::one(format!("RENAME COLUMN {from} TO {to}"))
    }
    fn alter_column(&self, _: &TableModel, _: &ColumnModel, after: &ColumnModel) -> Step {
        if self.in_place {
            Step::one(format!("ALTER {} TYPE {}", after.name, after.type_name))
        } else {
            Step::Rebuild
        }
    }
    fn column_comment(&self, _: &TableModel, _: &ColumnModel, after: &ColumnModel) -> Step {
        Step::one(format!("COMMENT COLUMN {}", after.name))
    }
    fn add_constraint(&self, _: &TableModel, constraint: &Constraint) -> Step {
        Step::one(format!("ADD CONSTRAINT {}", constraint.name()))
    }
    fn drop_constraint(&self, _: &TableModel, constraint: &Constraint) -> Step {
        Step::one(format!("DROP CONSTRAINT {}", constraint.name()))
    }
    fn create_index(&self, table: &TableModel, index: &IndexModel) -> String {
        format!("CREATE INDEX {} ON {}", index.name, self.table(table))
    }
    fn drop_index(&self, _: &TableModel, index: &IndexModel) -> String {
        format!("DROP INDEX {}", index.name)
    }
    fn transactional(&self) -> bool {
        self.in_place
    }
}

fn column(name: &str, type_name: &str) -> ColumnModel {
    ColumnModel {
        name: name.into(),
        original: name.into(),
        type_name: type_name.into(),
        nullable: true,
        ..ColumnModel::default()
    }
}
fn table() -> TableModel {
    TableModel {
        name: "items".into(),
        original: "items".into(),
        columns: vec![
            column("id", "int"),
            column("label", "text"),
            column("old", "text"),
        ],
        primary_key: Some(KeyModel {
            name: "items_pkey".into(),
            columns: vec!["id".into()],
        }),
        indexes: vec![IndexModel {
            name: "items_label".into(),
            columns: vec!["label".into()],
            ..IndexModel::default()
        }],
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
fn creates_and_drops_a_table() {
    let writer = Plain { in_place: true };
    let created = plan(&writer, &params(None, Some(table()))).unwrap();
    assert_eq!(
        created.statements,
        [
            "CREATE TABLE \"items\" (\"id\" int, \"label\" text, \"old\" text)",
            "CREATE INDEX items_label ON \"items\""
        ]
    );
    let dropped = plan(&writer, &params(Some(table()), None)).unwrap();
    assert_eq!(dropped.statements, ["DROP TABLE \"items\""]);
    assert!(dropped.warnings[0].contains("all its rows"));
    let mut nameless = table();
    nameless.name.clear();
    assert!(plan(&writer, &params(None, Some(nameless))).is_err());
}

#[test]
fn changes_a_table_in_order_and_warns_of_what_may_fail() {
    let writer = Plain { in_place: true };
    let mut after = table();
    after.name = "goods".into();
    after.columns.retain(|column| column.name != "old");
    after.columns[1].name = "title".into();
    after.columns[1].type_name = "varchar(20)".into();
    after.columns.push(ColumnModel {
        name: "price".into(),
        type_name: "numeric".into(),
        comment: Some("in euros".into()),
        ..ColumnModel::default()
    });
    after.primary_key = None;
    after.indexes.clear();
    after.foreign_keys.push(ForeignKeyModel {
        name: "goods_owner".into(),
        columns: vec!["id".into()],
        referenced_table: "owners".into(),
        referenced_columns: vec!["id".into()],
        ..ForeignKeyModel::default()
    });
    let planned = plan(&writer, &params(Some(table()), Some(after))).unwrap();
    assert_eq!(
        planned.statements,
        [
            "RENAME \"items\" TO \"goods\"",
            "DROP CONSTRAINT items_pkey",
            "DROP INDEX items_label",
            "DROP COLUMN old",
            "RENAME COLUMN label TO title",
            "ALTER title TYPE varchar(20)",
            "ADD \"price\" numeric NOT NULL",
            "ADD CONSTRAINT goods_owner",
        ]
    );
    assert!(
        planned
            .warnings
            .iter()
            .any(|w| w.contains("old is dropped"))
    );
    assert!(
        planned
            .warnings
            .iter()
            .any(|w| w.contains("from text to varchar(20)"))
    );
}

#[test]
fn an_engine_that_cannot_change_in_place_rebuilds_the_table() {
    let writer = Plain { in_place: false };
    let mut after = table();
    after.columns[1].type_name = "varchar(20)".into();
    after.columns.retain(|column| column.name != "old");
    let planned = plan(&writer, &params(Some(table()), Some(after))).unwrap();
    assert_eq!(
        planned.statements,
        [
            "CREATE TABLE \"items__nexo_new\" (\"id\" int, \"label\" varchar(20))",
            "INSERT INTO \"items__nexo_new\" (\"id\", \"label\") SELECT \"id\", \"label\" FROM \"items\"",
            "DROP TABLE \"items\"",
            "RENAME \"items__nexo_new\" TO \"items\"",
            "CREATE INDEX items_label ON \"items\"",
        ]
    );
    assert!(planned.warnings.iter().any(|w| w.contains("created again")));
    assert!(planned.warnings.iter().any(|w| w.contains("half way")));
}
