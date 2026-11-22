//! The answers of `query.json`: the columns with the types of `metadata`, and each value
//! (often text in the answer) converted by its column's type; maps and lists as JSON.
use nexo_driver_sdk::{Column, Value, ValueKind};
use serde_json::Value as Json;

/// The kind of a Drill type: `BIGINT`, `VARCHAR(65535)`, `DECIMAL(10, 2)`…
pub(crate) fn kind(name: &str) -> ValueKind {
    let base = name
        .split('(')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_uppercase();
    match base.as_str() {
        "BIGINT" | "INT" | "INTEGER" | "SMALLINT" | "TINYINT" | "UINT1" | "UINT2" | "UINT4"
        | "UINT8" => ValueKind::Integer,
        "FLOAT" | "FLOAT4" | "FLOAT8" | "DOUBLE" | "REAL" => ValueKind::Float,
        "DECIMAL" | "VARDECIMAL" | "NUMERIC" => ValueKind::Decimal,
        "BIT" | "BOOLEAN" => ValueKind::Boolean,
        "DATE" => ValueKind::Date,
        "TIME" => ValueKind::Time,
        "TIMESTAMP" => ValueKind::Timestamp,
        "INTERVAL" | "INTERVALDAY" | "INTERVALYEAR" => ValueKind::Interval,
        "MAP" | "LIST" | "STRUCT" | "ARRAY" | "DICT" | "UNION" => ValueKind::Json,
        _ => ValueKind::Text,
    }
}

/// A value of the answer, by its column.
pub(crate) fn cell(value: &Json, column: &Column) -> Value {
    let text = match value {
        Json::Null => return Value::Null,
        Json::String(text) => text.clone(),
        Json::Bool(flag) => flag.to_string(),
        Json::Number(number) => number.to_string(),
        other => return Value::typed(ValueKind::Json, other.to_string()),
    };
    match column.kind {
        ValueKind::Integer => match text.parse() {
            Ok(integer) => Value::Integer(integer),
            Err(_) => Value::typed(ValueKind::Integer, text),
        },
        ValueKind::Float => text.parse().map(Value::Float).unwrap_or(Value::Text(text)),
        ValueKind::Boolean => Value::Bool(matches!(text.as_str(), "true" | "1")),
        ValueKind::Text => Value::Text(text),
        kind => Value::typed(kind, text),
    }
}

/// The columns and rows of an answer.
pub(crate) fn rows(answer: &Json) -> (Vec<Column>, Vec<Vec<Value>>) {
    let names: Vec<&str> = answer["columns"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Json::as_str)
        .collect();
    let types: Vec<&str> = answer["metadata"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Json::as_str)
        .collect();
    let columns: Vec<Column> = names
        .iter()
        .enumerate()
        .map(|(at, name)| {
            let declared = types.get(at).copied().unwrap_or("VARCHAR");
            Column::new(*name, declared, kind(declared))
        })
        .collect();
    let rows = answer["rows"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|row| {
            columns
                .iter()
                .map(|column| cell(&row[&column.name], column))
                .collect()
        })
        .collect();
    (columns, rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// An answer of Drill 1.21 to a query on `cp.employee.json` and `nation.parquet`.
    #[test]
    fn values_are_converted_by_the_declared_types() {
        let answer = json!({
            "queryId": "1a2b",
            "columns": ["employee_id", "salary", "full_name", "birth", "manager", "tags", "big", "price"],
            "metadata": ["BIGINT", "FLOAT8", "VARCHAR(65535)", "DATE", "BIT", "LIST", "BIGINT", "VARDECIMAL(10, 2)"],
            "rows": [
                {"employee_id": "1", "salary": "80000.0", "full_name": "Sheri Nowmer",
                 "birth": "1961-08-26", "manager": "false", "tags": ["a", "b"],
                 "big": "99999999999999999999", "price": "19.50"},
                {"employee_id": 2, "salary": null, "full_name": "Derrick", "birth": null,
                 "manager": true, "tags": null, "big": 1, "price": null}
            ],
            "queryState": "COMPLETED"
        });
        let (columns, rows) = rows(&answer);
        assert_eq!(columns[3].kind, ValueKind::Date);
        assert_eq!(columns[7].type_name, "VARDECIMAL(10, 2)");
        assert_eq!(
            rows[0],
            [
                Value::Integer(1),
                Value::Float(80000.0),
                Value::Text("Sheri Nowmer".into()),
                Value::typed(ValueKind::Date, "1961-08-26"),
                Value::Bool(false),
                Value::typed(ValueKind::Json, "[\"a\",\"b\"]"),
                Value::typed(ValueKind::Integer, "99999999999999999999"),
                Value::typed(ValueKind::Decimal, "19.50"),
            ]
        );
        assert_eq!(rows[1][0], Value::Integer(2));
        assert_eq!(rows[1][1], Value::Null);
        assert_eq!(rows[1][4], Value::Bool(true));
        assert_eq!(kind("INTERVALDAY"), ValueKind::Interval);
        assert_eq!(kind("whatever"), ValueKind::Text);
    }
}
