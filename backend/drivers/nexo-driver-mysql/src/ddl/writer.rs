//! The DDL of MySQL and MariaDB for each change of a table (adapted in part from DBeaver,
//! Apache-2.0: plugins/org.jkiss.dbeaver.ext.mysql/edit). A column changes with `MODIFY`,
//! its whole declaration written again. Each statement commits on its own.
use nexo_driver_sdk::ddl::{
    ColumnModel, Constraint, DdlWriter, ForeignKeyModel, IndexModel, KeyModel, Step, TableModel,
    index_part,
};

pub struct MysqlWriter;

fn literal(text: &str) -> String {
    format!("'{}'", text.replace('\\', "\\\\").replace('\'', "''"))
}

impl MysqlWriter {
    fn names(&self, names: &[String]) -> String {
        names
            .iter()
            .map(|name| self.quote(name))
            .collect::<Vec<_>>()
            .join(", ")
    }
    fn named(&self, name: &str) -> String {
        if name.is_empty() {
            String::new()
        } else {
            format!("CONSTRAINT {} ", self.quote(name))
        }
    }
    fn foreign(&self, key: &ForeignKeyModel) -> String {
        let table = match &key.referenced_schema {
            Some(schema) => format!(
                "{}.{}",
                self.quote(schema),
                self.quote(&key.referenced_table)
            ),
            None => self.quote(&key.referenced_table),
        };
        let mut sql = format!(
            "{}FOREIGN KEY ({}) REFERENCES {table} ({})",
            self.named(&key.name),
            self.names(&key.columns),
            self.names(&key.referenced_columns)
        );
        for (event, action) in [("DELETE", &key.on_delete), ("UPDATE", &key.on_update)] {
            if !action.is_empty() && action != "NO ACTION" {
                sql.push_str(&format!(" ON {event} {action}"));
            }
        }
        sql
    }
    fn unique(&self, key: &KeyModel) -> String {
        format!(
            "{}UNIQUE ({})",
            self.named(&key.name),
            self.names(&key.columns)
        )
    }
    fn constraint(&self, constraint: &Constraint) -> String {
        match constraint {
            Constraint::PrimaryKey(key) => format!("PRIMARY KEY ({})", self.names(&key.columns)),
            Constraint::Unique(key) => self.unique(key),
            Constraint::Check(check) => {
                format!("{}CHECK ({})", self.named(&check.name), check.expression)
            }
            Constraint::ForeignKey(key) => self.foreign(key),
        }
    }
}

impl DdlWriter for MysqlWriter {
    fn table(&self, table: &TableModel) -> String {
        match &table.schema {
            Some(schema) => format!("{}.{}", self.quote(schema), self.quote(&table.name)),
            None => self.quote(&table.name),
        }
    }
    fn quote(&self, name: &str) -> String {
        format!("`{}`", name.replace('`', "``"))
    }
    fn column(&self, _: &TableModel, column: &ColumnModel) -> String {
        let mut sql = format!("{} {}", self.quote(&column.name), column.type_name);
        if !column.nullable {
            sql.push_str(" NOT NULL");
        }
        if let Some(default) = column.default.as_deref().filter(|text| !text.is_empty()) {
            sql.push_str(&format!(" DEFAULT {default}"));
        }
        if column.identity {
            sql.push_str(" AUTO_INCREMENT");
        }
        if let Some(comment) = column.comment.as_deref().filter(|text| !text.is_empty()) {
            sql.push_str(&format!(" COMMENT {}", literal(comment)));
        }
        sql
    }
    fn create(&self, table: &TableModel) -> Vec<String> {
        let mut parts: Vec<String> = table
            .columns
            .iter()
            .map(|c| self.column(table, c))
            .collect();
        let constraints = table
            .primary_key
            .iter()
            .map(|key| Constraint::PrimaryKey(key.clone()))
            .chain(table.uniques.iter().cloned().map(Constraint::Unique))
            .chain(table.checks.iter().cloned().map(Constraint::Check))
            .chain(
                table
                    .foreign_keys
                    .iter()
                    .cloned()
                    .map(Constraint::ForeignKey),
            );
        parts.extend(constraints.map(|constraint| self.constraint(&constraint)));
        let mut sql = format!(
            "CREATE TABLE {} (\n  {}\n)",
            self.table(table),
            parts.join(",\n  ")
        );
        if let Some(engine) = table.options.get("engine").filter(|text| !text.is_empty()) {
            sql.push_str(&format!(" ENGINE={engine}"));
        }
        if let Some(collation) = table
            .options
            .get("collation")
            .filter(|text| !text.is_empty())
        {
            sql.push_str(&format!(" COLLATE={collation}"));
        }
        if let Some(comment) = table.comment.as_deref().filter(|text| !text.is_empty()) {
            sql.push_str(&format!(" COMMENT={}", literal(comment)));
        }
        vec![sql]
    }
    fn drop(&self, table: &TableModel, _cascade: bool) -> Vec<String> {
        vec![format!("DROP TABLE {}", self.table(table))]
    }
    fn rename_table(&self, table: &TableModel, to: &str) -> Step {
        let mut renamed = table.clone();
        renamed.name = to.into();
        Step::one(format!(
            "RENAME TABLE {} TO {}",
            self.table(table),
            self.table(&renamed)
        ))
    }
    fn table_comment(&self, table: &TableModel, _: Option<&str>, after: Option<&str>) -> Step {
        Step::one(format!(
            "ALTER TABLE {} COMMENT = {}",
            self.table(table),
            literal(after.unwrap_or_default())
        ))
    }
    fn add_column(&self, table: &TableModel, column: &ColumnModel) -> Step {
        Step::one(format!(
            "ALTER TABLE {} ADD COLUMN {}",
            self.table(table),
            self.column(table, column)
        ))
    }
    fn drop_column(&self, table: &TableModel, column: &str) -> Step {
        Step::one(format!(
            "ALTER TABLE {} DROP COLUMN {}",
            self.table(table),
            self.quote(column)
        ))
    }
    fn rename_column(&self, table: &TableModel, from: &str, to: &str) -> Step {
        Step::one(format!(
            "ALTER TABLE {} RENAME COLUMN {} TO {}",
            self.table(table),
            self.quote(from),
            self.quote(to)
        ))
    }
    fn alter_column(&self, table: &TableModel, _: &ColumnModel, after: &ColumnModel) -> Step {
        Step::one(format!(
            "ALTER TABLE {} MODIFY COLUMN {}",
            self.table(table),
            self.column(table, after)
        ))
    }
    fn column_comment(
        &self,
        table: &TableModel,
        before: &ColumnModel,
        after: &ColumnModel,
    ) -> Step {
        // The declaration already went whole when the column changed in other ways.
        let changed = !before.type_name.eq_ignore_ascii_case(&after.type_name)
            || before.nullable != after.nullable
            || before.default != after.default
            || before.identity != after.identity;
        if changed {
            Step::Run(Vec::new())
        } else {
            self.alter_column(table, before, after)
        }
    }
    fn add_constraint(&self, table: &TableModel, constraint: &Constraint) -> Step {
        Step::one(format!(
            "ALTER TABLE {} ADD {}",
            self.table(table),
            self.constraint(constraint)
        ))
    }
    fn drop_constraint(&self, table: &TableModel, constraint: &Constraint) -> Step {
        let what = match constraint {
            Constraint::PrimaryKey(_) => "PRIMARY KEY".to_owned(),
            Constraint::Unique(key) => format!("INDEX {}", self.quote(&key.name)),
            Constraint::Check(check) => format!("CONSTRAINT {}", self.quote(&check.name)),
            Constraint::ForeignKey(key) => format!("FOREIGN KEY {}", self.quote(&key.name)),
        };
        Step::one(format!("ALTER TABLE {} DROP {what}", self.table(table)))
    }
    fn create_index(&self, table: &TableModel, index: &IndexModel) -> String {
        let (kind, using) = match index.method.to_ascii_lowercase().as_str() {
            "fulltext" => ("FULLTEXT ", String::new()),
            "spatial" => ("SPATIAL ", String::new()),
            "" => (if index.unique { "UNIQUE " } else { "" }, String::new()),
            method => (
                if index.unique { "UNIQUE " } else { "" },
                format!(" USING {}", method.to_ascii_uppercase()),
            ),
        };
        let columns: Vec<String> = index
            .columns
            .iter()
            .map(|column| index_part(self, column))
            .collect();
        format!(
            "CREATE {kind}INDEX {} ON {} ({}){using}",
            self.quote(&index.name),
            self.table(table),
            columns.join(", ")
        )
    }
    fn drop_index(&self, table: &TableModel, index: &IndexModel) -> String {
        format!(
            "DROP INDEX {} ON {}",
            self.quote(&index.name),
            self.table(table)
        )
    }
    fn transactional(&self) -> bool {
        false
    }
}
