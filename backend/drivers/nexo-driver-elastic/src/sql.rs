//! SQL through the engine's own API: `_sql` in Elasticsearch, `_plugins/_sql` in OpenSearch,
//! a page at a time with the cursor the server keeps (`fetch`, `close`); `_sql/translate` as
//! the plan, which is the Query DSL the statement becomes.
use crate::{Flavour, error::answer_error, http::Client};
use nexo_driver_sdk::{
    Column, DriverError, Result, Value, ValueKind,
    explain::{ExplainMode, Plan, PlanNode},
};
use serde_json::{Value as Json, json};

/// A column of an answer, as the engine types it.
pub(crate) fn column(name: &str, kind: &str) -> Column {
    let value = match kind {
        "long" | "integer" | "short" | "byte" | "unsigned_long" => ValueKind::Integer,
        "double" | "float" | "half_float" | "scaled_float" => ValueKind::Float,
        "boolean" => ValueKind::Boolean,
        "datetime" | "date" | "date_nanos" | "timestamp" => ValueKind::Timestamptz,
        "object" | "nested" | "struct" | "array" => ValueKind::Json,
        _ => ValueKind::Text,
    };
    Column::new(name, kind, value)
}

/// A cell of an answer, by its column.
pub(crate) fn cell(value: &Json, column: &Column) -> Value {
    match value {
        Json::Null => Value::Null,
        Json::Bool(flag) => Value::Bool(*flag),
        Json::Number(number) => match (number.as_i64(), column.kind) {
            (Some(integer), _) => Value::Integer(integer),
            (None, ValueKind::Integer) => Value::typed(ValueKind::Integer, number.to_string()),
            _ => Value::Float(number.as_f64().unwrap_or_default()),
        },
        Json::String(text) if column.kind == ValueKind::Timestamptz => {
            Value::typed(ValueKind::Timestamptz, text.clone())
        }
        Json::String(text) => Value::Text(text.clone()),
        other => Value::typed(ValueKind::Json, other.to_string()),
    }
}

/// A page of an answer: columns (on the first page), rows and the server's cursor.
pub(crate) struct SqlPage {
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Value>>,
    pub cursor: Option<String>,
}

fn endpoint(flavour: Flavour) -> &'static str {
    match flavour {
        Flavour::Elasticsearch => "/_sql?format=json",
        Flavour::OpenSearch => "/_plugins/_sql?format=jdbc",
    }
}

/// The type of a parameter, as OpenSearch asks for it.
fn parameter(value: &Value) -> Json {
    let (kind, value) = match value {
        Value::Integer(number) => ("long", json!(number)),
        Value::Float(number) => ("double", json!(number)),
        Value::Bool(flag) => ("boolean", json!(flag)),
        Value::Null => ("null", Json::Null),
        other => ("string", Json::from(other.clone())),
    };
    json!({"type": kind, "value": value})
}

async fn post(client: &Client, path: &str, body: &Json) -> Result<Json> {
    let answer = client
        .send(
            "POST",
            path,
            Some(("application/json", body.to_string().into_bytes())),
        )
        .await?;
    if answer.status == 404
        || (answer.status == 400 && String::from_utf8_lossy(&answer.body).contains("no handler"))
    {
        return Err(DriverError::invalid(
            "This server has no SQL API: it needs the SQL feature of Elasticsearch or the SQL plugin of OpenSearch",
        ));
    }
    if answer.status >= 400 {
        return Err(answer_error(&answer));
    }
    answer.json()
}

fn read(flavour: Flavour, answer: &Json, known: &[Column]) -> SqlPage {
    let (columns, rows) = match flavour {
        Flavour::Elasticsearch => ("columns", "rows"),
        Flavour::OpenSearch => ("schema", "datarows"),
    };
    let columns: Vec<Column> = match answer[columns].as_array() {
        Some(found) => found
            .iter()
            .map(|c| {
                let name = c["alias"]
                    .as_str()
                    .or(c["name"].as_str())
                    .unwrap_or_default();
                column(name, c["type"].as_str().unwrap_or("keyword"))
            })
            .collect(),
        None => known.to_vec(),
    };
    let rows = answer[rows]
        .as_array()
        .into_iter()
        .flatten()
        .map(|row| {
            let cells = row.as_array().cloned().unwrap_or_default();
            columns
                .iter()
                .zip(cells.iter().chain(std::iter::repeat(&Json::Null)))
                .map(|(c, v)| cell(v, c))
                .collect()
        })
        .collect();
    let cursor = answer["cursor"]
        .as_str()
        .filter(|c| !c.is_empty())
        .map(str::to_owned);
    SqlPage {
        columns,
        rows,
        cursor,
    }
}

/// The first page of a statement.
pub(crate) async fn query(
    client: &Client,
    flavour: Flavour,
    sql: &str,
    params: &[Value],
    rows: u32,
) -> Result<SqlPage> {
    let mut body = json!({"query": sql, "fetch_size": rows});
    if !params.is_empty() {
        match flavour {
            Flavour::Elasticsearch => {
                body["params"] = params.iter().map(|v| Json::from(v.clone())).collect()
            }
            Flavour::OpenSearch => body["parameters"] = params.iter().map(parameter).collect(),
        }
    }
    Ok(read(
        flavour,
        &post(client, endpoint(flavour), &body).await?,
        &[],
    ))
}

/// The next page of a cursor.
pub(crate) async fn next(
    client: &Client,
    flavour: Flavour,
    cursor: &str,
    columns: &[Column],
) -> Result<SqlPage> {
    let answer = post(client, endpoint(flavour), &json!({"cursor": cursor})).await?;
    Ok(read(flavour, &answer, columns))
}

/// Lets the server forget a cursor.
pub(crate) async fn close(client: &Client, flavour: Flavour, cursor: &str) -> Result<()> {
    let path = match flavour {
        Flavour::Elasticsearch => "/_sql/close",
        Flavour::OpenSearch => "/_plugins/_sql/close",
    };
    post(client, path, &json!({"cursor": cursor}))
        .await
        .map(|_| ())
}

/// The Query DSL a statement becomes, as its plan.
pub(crate) async fn translate(client: &Client, flavour: Flavour, sql: &str) -> Result<Plan> {
    let (path, body) = match flavour {
        Flavour::Elasticsearch => ("/_sql/translate", json!({"query": sql})),
        Flavour::OpenSearch => ("/_plugins/_sql/_explain", json!({"query": sql})),
    };
    let dsl = post(client, path, &body).await?;
    let original = serde_json::to_string_pretty(&dsl).unwrap_or_default();
    let node = PlanNode {
        operation: "Search".into(),
        details: [("query".to_owned(), dsl["query"].to_string())]
            .into_iter()
            .filter(|(_, query)| query != "null")
            .collect(),
        ..PlanNode::default()
    };
    Ok(Plan {
        mode: ExplainMode::Estimated,
        nodes: vec![node],
        format: "json".into(),
        original,
        total_ms: None,
        rolled_back: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_of_both_engines_keep_their_types() {
        let es = json!({
            "columns": [{"name": "n", "type": "long"}, {"name": "at", "type": "datetime"},
                        {"name": "user", "type": "object"}, {"name": "big", "type": "unsigned_long"}],
            "rows": [[1, "2024-01-01T00:00:00.000Z", {"a": 1}, 18446744073709551615u64]],
            "cursor": "abc"
        });
        let page = read(Flavour::Elasticsearch, &es, &[]);
        assert_eq!(page.cursor.as_deref(), Some("abc"));
        assert_eq!(
            page.rows[0],
            [
                Value::Integer(1),
                Value::typed(ValueKind::Timestamptz, "2024-01-01T00:00:00.000Z"),
                Value::typed(ValueKind::Json, "{\"a\":1}"),
                Value::typed(ValueKind::Integer, "18446744073709551615"),
            ]
        );
        let os = json!({"schema": [{"name": "x", "alias": "y", "type": "double"}], "datarows": [[1.5], []]});
        let page = read(Flavour::OpenSearch, &os, &[]);
        assert_eq!(page.columns[0].name, "y");
        assert_eq!(page.rows, [vec![Value::Float(1.5)], vec![Value::Null]]);
        // A next page without columns keeps the first page's.
        let more = read(
            Flavour::Elasticsearch,
            &json!({"rows": [[2]]}),
            &[column("n", "long")],
        );
        assert_eq!(more.rows, [vec![Value::Integer(2)]]);
        assert_eq!(
            parameter(&Value::Text("a".into())),
            json!({"type": "string", "value": "a"})
        );
    }
}
