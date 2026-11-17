//! The DDL of SQLite for each change of a table. SQLite renames tables and columns, adds
//! columns and drops plain ones in place; any other change rebuilds the table (created again,
//! its rows copied), which the plan explains. Comments are not kept: SQLite has none.
use nexo_driver_sdk::ddl::{
    ColumnModel, Constraint, DdlWriter, ForeignKeyModel, IndexModel, KeyModel, Step, TableModel,
    index_part,
};

pub struct SqliteWriter;

impl SqliteWriter {
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
        let mut sql = format!(
            "{}FOREIGN KEY ({}) REFERENCES {} ({})",
            self.named(&key.name),
            self.names(&key.columns),
            self.quote(&key.referenced_table),
            self.names(&key.referenced_columns)
        );
        for (event, action) in [("DELETE", &key.on_delete), ("UPDATE", &key.on_update)] {
            if !action.is_empty() && action != "NO ACTION" {
                sql.push_str(&format!(" ON {event} {action}"));
            }
        }
        sql
    }
    fn key(&self, kind: &str, key: &KeyModel) -> String {
        format!(
            "{}{kind} ({})",
            self.named(&key.name),
            self.names(&key.columns)
        )
    }
    /// The column whose identity makes it the table's own key (`INTEGER PRIMARY KEY`).
    fn identity<'a>(&self, table: &'a TableModel) -> Option<&'a ColumnModel> {
        table.columns.iter().find(|column| column.identity)
    }
    /// A column a key, a foreign key or an index uses: dropping it needs a rebuild.
    fn used(&self, table: &TableModel, column: &str) -> bool {
        let uses = |columns: &[String]| columns.iter().any(|each| each == column);
        table
            .primary_key
            .as_ref()
            .is_some_and(|key| uses(&key.columns))
            || table.uniques.iter().any(|key| uses(&key.columns))
            || table.foreign_keys.iter().any(|key| uses(&key.columns))
            || table.indexes.iter().any(|index| {
                index
                    .columns
                    .iter()
                    .any(|each| each.trim_end_matches(" DESC") == column)
            })
    }
}

impl DdlWriter for SqliteWriter {
    fn table(&self, table: &TableModel) -> String {
        self.quote(&table.name)
    }
    fn quote(&self, name: &str) -> String {
        format!("\"{}\"", name.replace('"', "\"\""))
    }
    fn column(&self, _: &TableModel, column: &ColumnModel) -> String {
        let mut sql = format!("{} {}", self.quote(&column.name), column.type_name);
        if column.identity {
            sql.push_str(" PRIMARY KEY AUTOINCREMENT");
        }
        if !column.nullable && !column.identity {
            sql.push_str(" NOT NULL");
        }
        if let Some(default) = column.default.as_deref().filter(|text| !text.is_empty()) {
            sql.push_str(&format!(" DEFAULT {default}"));
        }
        sql
    }
    fn create(&self, table: &TableModel) -> Vec<String> {
        let mut parts: Vec<String> = table
            .columns
            .iter()
            .map(|c| self.column(table, c))
            .collect();
        // The key of an identity column is declared with it.
        if let Some(key) = &table.primary_key
            && self.identity(table).is_none()
        {
            parts.push(self.key("PRIMARY KEY", key));
        }
        parts.extend(table.uniques.iter().map(|key| self.key("UNIQUE", key)));
        parts.extend(
            table
                .checks
                .iter()
                .map(|check| format!("{}CHECK ({})", self.named(&check.name), check.expression)),
        );
        parts.extend(table.foreign_keys.iter().map(|key| self.foreign(key)));
        vec![format!(
            "CREATE TABLE {} (\n  {}\n)",
            self.table(table),
            parts.join(",\n  ")
        )]
    }
    fn drop(&self, table: &TableModel, _cascade: bool) -> Vec<String> {
        vec![format!("DROP TABLE {}", self.table(table))]
    }
    fn rename_table(&self, table: &TableModel, to: &str) -> Step {
        Step::one(format!(
            "ALTER TABLE {} RENAME TO {}",
            self.table(table),
            self.quote(to)
        ))
    }
    fn table_comment(&self, _: &TableModel, _: Option<&str>, _: Option<&str>) -> Step {
        Step::Run(Vec::new())
    }
    fn add_column(&self, table: &TableModel, column: &ColumnModel) -> Step {
        // SQLite adds no key, and no NOT NULL column without a default.
        if column.identity || (!column.nullable && column.default.is_none()) {
            return Step::Rebuild;
        }
        Step::one(format!(
            "ALTER TABLE {} ADD COLUMN {}",
            self.table(table),
            self.column(table, column)
        ))
    }
    fn drop_column(&self, table: &TableModel, column: &str) -> Step {
        if self.used(table, column) {
            return Step::Rebuild;
        }
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
    fn alter_column(&self, _: &TableModel, _: &ColumnModel, _: &ColumnModel) -> Step {
        Step::Rebuild
    }
    fn column_comment(&self, _: &TableModel, _: &ColumnModel, _: &ColumnModel) -> Step {
        Step::Run(Vec::new())
    }
    fn add_constraint(&self, _: &TableModel, _: &Constraint) -> Step {
        Step::Rebuild
    }
    fn drop_constraint(&self, _: &TableModel, _: &Constraint) -> Step {
        Step::Rebuild
    }
    fn create_index(&self, table: &TableModel, index: &IndexModel) -> String {
        let unique = if index.unique { "UNIQUE " } else { "" };
        let columns: Vec<String> = index
            .columns
            .iter()
            .map(|column| index_part(self, column))
            .collect();
        let mut sql = format!(
            "CREATE {unique}INDEX {} ON {} ({})",
            self.quote(&index.name),
            self.table(table),
            columns.join(", ")
        );
        if !index.condition.is_empty() {
            sql.push_str(&format!(" WHERE {}", index.condition));
        }
        sql
    }
    fn drop_index(&self, _: &TableModel, index: &IndexModel) -> String {
        format!("DROP INDEX {}", self.quote(&index.name))
    }
    fn transactional(&self) -> bool {
        true
    }
}
