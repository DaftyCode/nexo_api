//! A table's DDL rebuilt from the system views: its columns with their SQL types, its primary
//! key with the kind of its index, its colocation when it is not the key, its zone and storage
//! profile, then its other indexes. The views keep no defaults, so none are written.
use super::{TableColumn, quote, text};
use crate::connection::Connection;
use nexo_driver_sdk::{Result, Value};

/// An index of a table.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Index {
    pub id: i64,
    pub name: String,
    /// `HASH` or `SORTED`.
    pub kind: String,
    pub unique: bool,
    /// As the view writes them: `NAME DESC, PRICE ASC`.
    pub listed: String,
    pub state: String,
    /// Each column with its order (`DESC_NULLS_FIRST`) in a sorted index.
    pub columns: Vec<(String, String)>,
}

impl Index {
    pub fn row(&self) -> Vec<Value> {
        vec![
            Value::Text(self.name.clone()),
            Value::Text(self.kind.clone()),
            Value::Bool(self.unique),
            Value::Text(self.listed.clone()),
            Value::Text(self.state.clone()),
        ]
    }
    fn columns_sql(&self) -> String {
        let columns: Vec<String> = self
            .columns
            .iter()
            .map(|(name, order)| {
                let order = match order.as_str() {
                    "ASC_NULLS_LAST" => " ASC",
                    "DESC_NULLS_FIRST" => " DESC",
                    "ASC_NULLS_FIRST" => " ASC NULLS FIRST",
                    "DESC_NULLS_LAST" => " DESC NULLS LAST",
                    _ => "",
                };
                format!("{}{order}", quote(name))
            })
            .collect();
        columns.join(", ")
    }
}

/// What a table has besides its columns.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Table {
    pub zone: String,
    pub storage: String,
    pub colocation: String,
    pub primary: Option<Index>,
    pub indexes: Vec<Index>,
}

/// The SQL type of a column, from Ignite's name of it and its sizes.
pub fn sql_type(column: &TableColumn) -> String {
    let sized = |name: &str, size: i64| {
        if size > 0 {
            format!("{name}({size})")
        } else {
            name.to_owned()
        }
    };
    match column.kind.as_str() {
        "INT8" => "TINYINT".into(),
        "INT16" => "SMALLINT".into(),
        "INT32" => "INT".into(),
        "INT64" => "BIGINT".into(),
        "FLOAT" => "REAL".into(),
        "DECIMAL" if column.precision > 0 => {
            format!("DECIMAL({}, {})", column.precision, column.scale)
        }
        "TIME" => sized("TIME", column.precision),
        "DATETIME" => sized("TIMESTAMP", column.precision),
        "TIMESTAMP" => format!(
            "{} WITH LOCAL TIME ZONE",
            sized("TIMESTAMP", column.precision)
        ),
        "STRING" => sized("VARCHAR", column.length),
        "BYTE_ARRAY" => sized("VARBINARY", column.length),
        "PERIOD" => "INTERVAL YEAR TO MONTH".into(),
        "DURATION" => "INTERVAL DAY TO SECOND".into(),
        other => other.to_owned(),
    }
}

/// The columns of the primary key, in its order.
pub fn key_columns(columns: &[TableColumn]) -> Vec<String> {
    let mut keyed: Vec<&TableColumn> = columns.iter().filter(|c| c.key.is_some()).collect();
    keyed.sort_by_key(|column| column.key);
    keyed.iter().map(|column| column.name.clone()).collect()
}

fn colocated(columns: &[TableColumn]) -> Vec<String> {
    let mut keyed: Vec<&TableColumn> = columns.iter().filter(|c| c.colocation.is_some()).collect();
    keyed.sort_by_key(|column| column.colocation);
    keyed.iter().map(|column| column.name.clone()).collect()
}

/// The table's zone, key and indexes; `None` for a system view.
pub async fn table(connection: &Connection, path: &[String]) -> Result<Option<Table>> {
    let args: Vec<Value> = path.iter().map(|part| Value::Text(part.clone())).collect();
    let found = connection
        .query(
            "SELECT ZONE_NAME, STORAGE_PROFILE, TABLE_COLOCATION_COLUMNS, TABLE_PK_INDEX_ID \
             FROM SYSTEM.TABLES WHERE SCHEMA_NAME = ? AND TABLE_NAME = ?",
            &args,
        )
        .await?;
    let Some(row) = found.first() else {
        return Ok(None);
    };
    let primary_id = match row.get(3) {
        Some(Value::Integer(id)) => *id,
        _ => -1,
    };
    let indexes = connection
        .query(
            "SELECT INDEX_ID, INDEX_NAME, INDEX_TYPE, IS_UNIQUE_INDEX, INDEX_COLUMNS, INDEX_STATE \
             FROM SYSTEM.INDEXES WHERE SCHEMA_NAME = ? AND TABLE_NAME = ? ORDER BY INDEX_ID",
            &args,
        )
        .await?;
    let columns = connection
        .query(
            "SELECT INDEX_NAME, COLUMN_NAME, COLUMN_COLLATION FROM SYSTEM.INDEX_COLUMNS \
             WHERE SCHEMA_NAME = ? AND TABLE_NAME = ? ORDER BY INDEX_ID, COLUMN_ORDINAL",
            &args,
        )
        .await?;
    let mut table = Table {
        zone: text(row.first()),
        storage: text(row.get(1)),
        colocation: text(row.get(2)),
        ..Table::default()
    };
    for found in &indexes {
        let name = text(found.get(1));
        let index = Index {
            id: match found.first() {
                Some(Value::Integer(id)) => *id,
                _ => -1,
            },
            columns: columns
                .iter()
                .filter(|column| text(column.first()) == name)
                .map(|column| (text(column.get(1)), text(column.get(2))))
                .collect(),
            name,
            kind: text(found.get(2)),
            unique: found.get(3) == Some(&Value::Bool(true)),
            listed: text(found.get(4)),
            state: text(found.get(5)),
        };
        if index.id == primary_id {
            table.primary = Some(index.clone());
        }
        table.indexes.push(index);
    }
    Ok(Some(table))
}

/// `CREATE TABLE` with its key, colocation, zone and profile, then `CREATE INDEX` for the
/// indexes that are not the key's.
pub fn create(path: &[String], columns: &[TableColumn], table: &Table) -> String {
    let name = format!("{}.{}", quote(&path[0]), quote(&path[1]));
    let mut lines: Vec<String> = columns
        .iter()
        .map(|column| {
            let null = if column.nullable { "" } else { " NOT NULL" };
            format!("    {} {}{null}", quote(&column.name), sql_type(column))
        })
        .collect();
    let key = key_columns(columns);
    if !key.is_empty() {
        let kind = match &table.primary {
            Some(index) if !index.kind.is_empty() => format!(" USING {}", index.kind),
            _ => String::new(),
        };
        let listed = match &table.primary {
            Some(index) if index.kind == "SORTED" => index.columns_sql(),
            _ => key
                .iter()
                .map(|column| quote(column))
                .collect::<Vec<_>>()
                .join(", "),
        };
        lines.push(format!("    PRIMARY KEY{kind} ({listed})"));
    }
    let mut sql = format!("CREATE TABLE {name} (\n{}\n)", lines.join(",\n"));
    let colocation = colocated(columns);
    if !colocation.is_empty() && colocation != key {
        let listed: Vec<String> = colocation.iter().map(|column| quote(column)).collect();
        sql.push_str(&format!(" COLOCATE BY ({})", listed.join(", ")));
    }
    if !table.zone.is_empty() {
        sql.push_str(&format!(" ZONE {}", quote(&table.zone)));
    }
    if !table.storage.is_empty() {
        sql.push_str(&format!(
            " STORAGE PROFILE '{}'",
            table.storage.replace('\'', "''")
        ));
    }
    sql.push(';');
    for index in &table.indexes {
        if table
            .primary
            .as_ref()
            .is_some_and(|primary| primary.id == index.id)
        {
            continue;
        }
        sql.push_str(&format!(
            "\n\nCREATE INDEX {} ON {name} USING {} ({});",
            quote(&index.name),
            index.kind,
            index.columns_sql()
        ));
    }
    sql
}

#[cfg(test)]
mod tests;
