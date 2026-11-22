//! What the catalog says of keyspaces and columns: replication in a few words, and the place
//! of each column in the key of its table.
use crate::connection::{rows, text};
use nexo_driver_sdk::{Result, Value};
use scylla::client::session::Session;

/// The replication of a keyspace in a few words: `SimpleStrategy, 3` or the factor of each
/// data center.
pub(crate) fn replication(value: &Value) -> String {
    let Value::Typed { text, .. } = value else {
        return String::new();
    };
    let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(text) else {
        return String::new();
    };
    let class = map
        .get("class")
        .and_then(|class| class.as_str())
        .unwrap_or_default()
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_owned();
    let factors: Vec<String> = map
        .iter()
        .filter(|(key, _)| key.as_str() != "class")
        .map(|(key, value)| {
            let value = value.as_str().unwrap_or_default();
            if key == "replication_factor" {
                value.to_owned()
            } else {
                format!("{key}: {value}")
            }
        })
        .collect();
    if factors.is_empty() {
        class
    } else {
        format!("{class}, {}", factors.join(", "))
    }
}

/// Where a column stands in the key of its table, for the tree and the describe.
pub(crate) fn key_role(row: &[Value]) -> String {
    let position = text(row, 3);
    match text(row, 2).as_str() {
        "partition_key" => format!("partition key {}", position.parse::<i64>().unwrap_or(0) + 1),
        "clustering" => format!(
            "clustering {} ({})",
            position.parse::<i64>().unwrap_or(0) + 1,
            text(row, 4).to_lowercase()
        ),
        "static" => "static".into(),
        _ => String::new(),
    }
}

/// The columns of a table or view: name, type, kind, position and clustering order, in the
/// order of the key first.
pub(crate) async fn columns(
    session: &Session,
    keyspace: &str,
    table: &str,
) -> Result<Vec<Vec<Value>>> {
    let (_, mut rows) = rows(
        session,
        "SELECT column_name, type, kind, position, clustering_order FROM system_schema.columns \
         WHERE keyspace_name = ? AND table_name = ?",
        &[keyspace, table],
    )
    .await?;
    let rank = |row: &Vec<Value>| match text(row, 2).as_str() {
        "partition_key" => 0,
        "clustering" => 1,
        "static" => 2,
        _ => 3,
    };
    rows.sort_by(|a, b| {
        rank(a)
            .cmp(&rank(b))
            .then(
                text(a, 3)
                    .parse::<i64>()
                    .unwrap_or(0)
                    .cmp(&text(b, 3).parse().unwrap_or(0)),
            )
            .then(text(a, 0).cmp(&text(b, 0)))
    });
    Ok(rows)
}
