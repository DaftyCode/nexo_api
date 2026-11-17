//! The DDL of SQL Server for each change of a table (adapted in part from DBeaver,
//! Apache-2.0: plugins/org.jkiss.dbeaver.ext.mssql/edit). Defaults are named constraints,
//! dropped by the name the server gave them; comments are the `MS_Description` extended
//! property. Every change runs in a transaction.
use nexo_driver_sdk::ddl::{
    ColumnModel, Constraint, DdlWriter, IndexModel, Step, TableModel, index_part,
};

pub struct SqlServerWriter;

pub(super) fn literal(text: &str) -> String {
    format!("N'{}'", text.replace('\'', "''"))
}

mod parts;

impl DdlWriter for SqlServerWriter {
    fn table(&self, table: &TableModel) -> String {
        format!(
            "{}.{}",
            self.quote(&self.schema(table)),
            self.quote(&table.name)
        )
    }
    fn quote(&self, name: &str) -> String {
        format!("[{}]", name.replace(']', "]]"))
    }
    fn column(&self, _: &TableModel, column: &ColumnModel) -> String {
        let mut sql = format!("{} {}", self.quote(&column.name), column.type_name);
        if column.identity {
            sql.push_str(" IDENTITY(1,1)");
        }
        sql.push_str(if column.nullable {
            " NULL"
        } else {
            " NOT NULL"
        });
        if let Some(default) = column.default.as_deref().filter(|text| !text.is_empty()) {
            sql.push_str(&format!(" DEFAULT ({default})"));
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
        let mut statements = vec![format!(
            "CREATE TABLE {} (\n  {}\n)",
            self.table(table),
            parts.join(",\n  ")
        )];
        statements.extend(self.description(table, None, None, table.comment.as_deref()));
        for column in &table.columns {
            statements.extend(self.description(
                table,
                Some(&column.name),
                None,
                column.comment.as_deref(),
            ));
        }
        statements
    }
    fn drop(&self, table: &TableModel, _cascade: bool) -> Vec<String> {
        vec![format!("DROP TABLE {}", self.table(table))]
    }
    fn rename_table(&self, table: &TableModel, to: &str) -> Step {
        Step::one(format!(
            "EXEC sp_rename {}, {}",
            self.object(table),
            literal(to)
        ))
    }
    fn table_comment(&self, table: &TableModel, before: Option<&str>, after: Option<&str>) -> Step {
        Step::Run(self.description(table, None, before, after))
    }
    fn add_column(&self, table: &TableModel, column: &ColumnModel) -> Step {
        let mut statements = vec![format!(
            "ALTER TABLE {} ADD {}",
            self.table(table),
            self.column(table, column)
        )];
        statements.extend(self.description(
            table,
            Some(&column.name),
            None,
            column.comment.as_deref(),
        ));
        Step::Run(statements)
    }
    fn drop_column(&self, table: &TableModel, column: &str) -> Step {
        Step::Run(vec![
            self.drop_default(table, column),
            format!(
                "ALTER TABLE {} DROP COLUMN {}",
                self.table(table),
                self.quote(column)
            ),
        ])
    }
    fn rename_column(&self, table: &TableModel, from: &str, to: &str) -> Step {
        let object = format!(
            "{}.{}.{}",
            self.quote(&self.schema(table)),
            self.quote(&table.name),
            self.quote(from)
        );
        Step::one(format!(
            "EXEC sp_rename {}, {}, N'COLUMN'",
            literal(&object),
            literal(to)
        ))
    }
    fn alter_column(&self, table: &TableModel, before: &ColumnModel, after: &ColumnModel) -> Step {
        if before.identity != after.identity {
            return Step::Unsupported(format!(
                "SQL Server cannot add or remove the identity of {} in place: copy the table into a new one",
                after.name
            ));
        }
        let mut statements = Vec::new();
        let default_changed = before.default != after.default;
        let declaration_changed = !before.type_name.eq_ignore_ascii_case(&after.type_name)
            || before.nullable != after.nullable;
        if default_changed || (declaration_changed && before.default.is_some()) {
            statements.push(self.drop_default(table, &after.name));
        }
        if declaration_changed {
            let null = if after.nullable { "NULL" } else { "NOT NULL" };
            statements.push(format!(
                "ALTER TABLE {} ALTER COLUMN {} {} {null}",
                self.table(table),
                self.quote(&after.name),
                after.type_name
            ));
        }
        if let Some(default) = after.default.as_deref().filter(|text| !text.is_empty())
            && (default_changed || declaration_changed)
        {
            statements.push(format!(
                "ALTER TABLE {} ADD DEFAULT ({default}) FOR {}",
                self.table(table),
                self.quote(&after.name)
            ));
        }
        Step::Run(statements)
    }
    fn column_comment(
        &self,
        table: &TableModel,
        before: &ColumnModel,
        after: &ColumnModel,
    ) -> Step {
        Step::Run(self.description(
            table,
            Some(&after.name),
            before.comment.as_deref(),
            after.comment.as_deref(),
        ))
    }
    fn add_constraint(&self, table: &TableModel, constraint: &Constraint) -> Step {
        Step::one(format!(
            "ALTER TABLE {} ADD {}",
            self.table(table),
            self.constraint(constraint)
        ))
    }
    fn drop_constraint(&self, table: &TableModel, constraint: &Constraint) -> Step {
        Step::one(format!(
            "ALTER TABLE {} DROP CONSTRAINT {}",
            self.table(table),
            self.quote(constraint.name())
        ))
    }
    fn create_index(&self, table: &TableModel, index: &IndexModel) -> String {
        let unique = if index.unique { "UNIQUE " } else { "" };
        let clustered = if index.method.eq_ignore_ascii_case("clustered") {
            "CLUSTERED "
        } else {
            ""
        };
        let columns: Vec<String> = index
            .columns
            .iter()
            .map(|column| index_part(self, column))
            .collect();
        let mut sql = format!(
            "CREATE {unique}{clustered}INDEX {} ON {} ({})",
            self.quote(&index.name),
            self.table(table),
            columns.join(", ")
        );
        if !index.condition.is_empty() {
            sql.push_str(&format!(" WHERE {}", index.condition));
        }
        sql
    }
    fn drop_index(&self, table: &TableModel, index: &IndexModel) -> String {
        format!(
            "DROP INDEX {} ON {}",
            self.quote(&index.name),
            self.table(table)
        )
    }
    fn transactional(&self) -> bool {
        true
    }
}
