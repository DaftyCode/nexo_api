//! What the DDL of SQL Server repeats: lists of names, constraints, the default of a column
//! dropped by the name the server gave it, and the `MS_Description` of a comment.
use super::{SqlServerWriter, literal};
use nexo_driver_sdk::ddl::{Constraint, DdlWriter, ForeignKeyModel, KeyModel, TableModel};

impl SqlServerWriter {
    pub(super) fn names(&self, names: &[String]) -> String {
        names
            .iter()
            .map(|name| self.quote(name))
            .collect::<Vec<_>>()
            .join(", ")
    }
    pub(super) fn schema(&self, table: &TableModel) -> String {
        table.schema.clone().unwrap_or_else(|| "dbo".into())
    }
    /// `N'dbo.items'`, for `OBJECT_ID` and `sp_rename`.
    pub(super) fn object(&self, table: &TableModel) -> String {
        literal(&format!(
            "{}.{}",
            self.quote(&self.schema(table)),
            self.quote(&table.name)
        ))
    }
    pub(super) fn named(&self, name: &str) -> String {
        if name.is_empty() {
            String::new()
        } else {
            format!("CONSTRAINT {} ", self.quote(name))
        }
    }
    pub(super) fn key(&self, kind: &str, key: &KeyModel) -> String {
        format!(
            "{}{kind} ({})",
            self.named(&key.name),
            self.names(&key.columns)
        )
    }
    pub(super) fn foreign(&self, key: &ForeignKeyModel) -> String {
        let table = format!(
            "{}.{}",
            self.quote(key.referenced_schema.as_deref().unwrap_or("dbo")),
            self.quote(&key.referenced_table)
        );
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
    pub(super) fn constraint(&self, constraint: &Constraint) -> String {
        match constraint {
            Constraint::PrimaryKey(key) => self.key("PRIMARY KEY", key),
            Constraint::Unique(key) => self.key("UNIQUE", key),
            Constraint::Check(check) => {
                format!("{}CHECK ({})", self.named(&check.name), check.expression)
            }
            Constraint::ForeignKey(key) => self.foreign(key),
        }
    }
    /// Drops the default of a column, by the name the server gave its constraint.
    pub(super) fn drop_default(&self, table: &TableModel, column: &str) -> String {
        let object = self.object(table);
        format!(
            "DECLARE @nexo_default sysname = (SELECT d.name FROM sys.default_constraints d \
             WHERE d.parent_object_id = OBJECT_ID({object}) \
             AND d.parent_column_id = COLUMNPROPERTY(OBJECT_ID({object}), {}, 'ColumnId')); \
             IF @nexo_default IS NOT NULL EXEC (N'ALTER TABLE {} DROP CONSTRAINT [' + @nexo_default + N']')",
            literal(column),
            self.table(table).replace('\'', "''")
        )
    }
    /// The `MS_Description` of a table or one of its columns: added, changed or dropped.
    pub(super) fn description(
        &self,
        table: &TableModel,
        column: Option<&str>,
        before: Option<&str>,
        after: Option<&str>,
    ) -> Vec<String> {
        let target = format!(
            "N'SCHEMA', {}, N'TABLE', {}{}",
            literal(&self.schema(table)),
            literal(&table.name),
            column.map_or(String::new(), |column| format!(
                ", N'COLUMN', {}",
                literal(column)
            ))
        );
        let (before, after) = (
            before.filter(|t| !t.is_empty()),
            after.filter(|t| !t.is_empty()),
        );
        match (before, after) {
            (None, Some(text)) => vec![format!(
                "EXEC sys.sp_addextendedproperty N'MS_Description', {}, {target}",
                literal(text)
            )],
            (Some(_), Some(text)) => vec![format!(
                "EXEC sys.sp_updateextendedproperty N'MS_Description', {}, {target}",
                literal(text)
            )],
            (Some(_), None) => vec![format!(
                "EXEC sys.sp_dropextendedproperty N'MS_Description', {target}"
            )],
            (None, None) => Vec::new(),
        }
    }
}
