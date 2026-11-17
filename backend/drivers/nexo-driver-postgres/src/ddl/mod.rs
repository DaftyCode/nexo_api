//! The structure editor of PostgreSQL: the model of a table read from `pg_catalog`, the types
//! a column may take (also domains, enums and the user's types, as DBeaver lists them), and
//! the DDL of each change ([`writer`]).
#[cfg(test)]
mod tests;
pub(crate) mod writer;

use crate::{
    catalog::{RELATION, database_of, query, text},
    connection::PgConnection,
};
use nexo_driver_sdk::{
    DriverError, Result,
    ddl::{CheckModel, ColumnModel, DdlModel, ForeignKeyModel, IndexModel, KeyModel, TableModel},
};

const COLUMNS: &str = "SELECT a.attname::text, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, \
    pg_get_expr(d.adbin, d.adrelid), a.attidentity <> '', col_description(a.attrelid, a.attnum) \
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
    WHERE a.attrelid = RELATION AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum";

const CONSTRAINTS: &str = "SELECT c.conname::text, c.contype::text, pg_get_constraintdef(c.oid), \
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n, i) \
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n ORDER BY k.i), \
    rn.nspname::text, r.relname::text, \
    ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(n, i) \
      JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n ORDER BY k.i), \
    c.confdeltype::text, c.confupdtype::text \
    FROM pg_constraint c LEFT JOIN pg_class r ON r.oid = c.confrelid \
    LEFT JOIN pg_namespace rn ON rn.oid = r.relnamespace \
    WHERE c.conrelid = RELATION AND c.contype IN ('p', 'u', 'c', 'f') ORDER BY c.contype, c.conname";

const INDEXES: &str = "SELECT i.relname::text, x.indisunique, am.amname::text, \
    pg_get_expr(x.indpred, x.indrelid), \
    ARRAY(SELECT pg_get_indexdef(x.indexrelid, k + 1, true) || \
      CASE WHEN x.indoption[k] & 1 = 1 THEN ' DESC' ELSE '' END \
      FROM generate_subscripts(x.indkey, 1) k ORDER BY k) \
    FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_am am ON am.oid = i.relam \
    WHERE x.indrelid = RELATION \
    AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = x.indexrelid) ORDER BY 1";

/// Base types, domains, enums, ranges and composite types of the user, by the name a column
/// takes them with.
const TYPES: &str = "SELECT DISTINCT format_type(t.oid, NULL) FROM pg_type t \
    JOIN pg_namespace n ON n.oid = t.typnamespace \
    WHERE t.typisdefined AND t.typtype IN ('b', 'd', 'e', 'r', 'm', 'c') \
    AND (t.typrelid = 0 OR (SELECT c.relkind FROM pg_class c WHERE c.oid = t.typrelid) = 'c') \
    AND t.typname NOT LIKE '\\_%' AND n.nspname NOT IN ('pg_toast', 'information_schema') \
    AND NOT (n.nspname = 'pg_catalog' AND t.typcategory IN ('P', 'X', 'Z')) ORDER BY 1";

/// `NO ACTION`… from the letter of `pg_constraint`.
fn action(letter: &str) -> String {
    match letter {
        "r" => "RESTRICT",
        "c" => "CASCADE",
        "n" => "SET NULL",
        "d" => "SET DEFAULT",
        _ => "",
    }
    .into()
}

/// `CHECK ((total > 0))` → `(total > 0)`.
fn check_expression(definition: &str) -> String {
    let inner = definition.trim().trim_start_matches("CHECK").trim();
    match inner
        .strip_prefix('(')
        .and_then(|rest| rest.strip_suffix(')'))
    {
        Some(expression) => expression.trim().to_owned(),
        None => inner.to_owned(),
    }
}

/// The model of the table at `path` (empty: the types alone, for a new table).
pub(crate) async fn model(connection: &PgConnection, path: &[String]) -> Result<DdlModel> {
    let (_, client) = database_of(connection, path).await?;
    let types: Vec<String> = query(&client, TYPES, &[])
        .await?
        .iter()
        .map(|row| text(row, 0))
        .collect();
    let [_, schemas, schema, folder, name] = path else {
        if path.is_empty() {
            return Ok(DdlModel {
                types,
                ..DdlModel::default()
            });
        }
        return Err(DriverError::invalid("Only a table has a structure to edit"));
    };
    if schemas != "schemas" || !matches!(folder.as_str(), "tables" | "foreign-tables") {
        return Err(DriverError::invalid("Only a table has a structure to edit"));
    }
    let params: [&(dyn tokio_postgres::types::ToSql + Sync); 2] = [schema, name];
    let sql = |base: &str| base.replace("RELATION", RELATION);
    let columns = query(&client, &sql(COLUMNS), &params).await?;
    if columns.is_empty() {
        return Err(DriverError::invalid(format!(
            "There is no table {schema}.{name}"
        )));
    }
    let mut table = TableModel {
        schema: Some(schema.clone()),
        name: name.clone(),
        original: name.clone(),
        ..TableModel::default()
    };
    for row in &columns {
        let column: String = text(row, 0);
        table.columns.push(ColumnModel {
            original: column.clone(),
            name: column,
            type_name: text(row, 1),
            nullable: row.get(2),
            default: row.get::<_, Option<String>>(3),
            identity: row.get(4),
            comment: row.get::<_, Option<String>>(5),
        });
    }
    for row in query(&client, &sql(CONSTRAINTS), &params).await? {
        let name = text(&row, 0);
        let columns: Vec<String> = row.get(3);
        match text(&row, 1).as_str() {
            "p" => table.primary_key = Some(KeyModel { name, columns }),
            "u" => table.uniques.push(KeyModel { name, columns }),
            "c" => table.checks.push(CheckModel {
                name,
                expression: check_expression(&text(&row, 2)),
            }),
            _ => table.foreign_keys.push(ForeignKeyModel {
                name,
                columns,
                referenced_schema: row.get::<_, Option<String>>(4),
                referenced_table: text(&row, 5),
                referenced_columns: row.get(6),
                on_delete: action(&text(&row, 7)),
                on_update: action(&text(&row, 8)),
            }),
        }
    }
    for row in query(&client, &sql(INDEXES), &params).await? {
        let method = text(&row, 2);
        table.indexes.push(IndexModel {
            name: text(&row, 0),
            unique: row.get(1),
            method: if method == "btree" {
                String::new()
            } else {
                method
            },
            condition: row.get::<_, Option<String>>(3).unwrap_or_default(),
            columns: row.get(4),
        });
    }
    let comment = format!("SELECT obj_description({RELATION}, 'pg_class')");
    table.comment = query(&client, &comment, &params)
        .await?
        .first()
        .and_then(|row| row.get::<_, Option<String>>(0));
    Ok(DdlModel { table, types })
}
