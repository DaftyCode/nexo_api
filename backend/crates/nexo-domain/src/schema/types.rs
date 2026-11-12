//! The type of a value: BSON types from canonical Extended JSON, or JSON types from plain
//! JSON. Also what orders values of a type, for its minimum and maximum.
use super::Flavor;
use serde_json::{Map, Value};

/// The name of the type of a value, as the explorer shows it.
pub fn type_name(value: &Value, flavor: Flavor) -> &'static str {
    match value {
        Value::Null => "Null",
        Value::Bool(_) => "Boolean",
        Value::String(_) => "String",
        Value::Array(_) => "Array",
        Value::Number(number) => match flavor {
            Flavor::Json if number.is_f64() => "Number",
            Flavor::Json => "Integer",
            Flavor::Bson if number.is_f64() => "Double",
            Flavor::Bson => match number.as_i64() {
                Some(n) if i32::try_from(n).is_ok() => "Int32",
                _ => "Int64",
            },
        },
        Value::Object(fields) => match flavor {
            Flavor::Json => "Object",
            Flavor::Bson => wrapper(fields).unwrap_or("Document"),
        },
    }
}

/// The BSON type a canonical Extended JSON wrapper (`{$oid: …}`, `{$date: …}`…) stands for.
fn wrapper(fields: &Map<String, Value>) -> Option<&'static str> {
    let (key, value) = fields.iter().next()?;
    let single = fields.len() == 1;
    Some(match key.as_str() {
        "$oid" if single => "ObjectId",
        "$date" if single => "Date",
        "$numberInt" if single => "Int32",
        "$numberLong" if single => "Int64",
        "$numberDouble" if single => "Double",
        "$numberDecimal" if single => "Decimal128",
        "$binary" if single => {
            let subtype = value.get("subType").and_then(Value::as_str).unwrap_or("");
            if subtype == "04" { "UUID" } else { "Binary" }
        }
        "$regularExpression" if single => "RegExp",
        "$timestamp" if single => "Timestamp",
        "$minKey" if single => "MinKey",
        "$maxKey" if single => "MaxKey",
        "$code" if fields.keys().all(|key| key == "$code" || key == "$scope") => "Code",
        "$symbol" if single => "Symbol",
        "$dbPointer" if single => "DBPointer",
        "$undefined" if single => "Undefined",
        _ => return None,
    })
}

/// Whether a type holds other values: a document, an object or an array.
pub fn is_container(name: &str) -> bool {
    matches!(name, "Document" | "Object" | "Array")
}

/// How values of a type are ordered, for the minimum and maximum of a field.
#[derive(Debug, Clone, PartialEq, PartialOrd)]
pub enum Order {
    Number(f64),
    Text(String),
}

/// The position of a value among those of its type, when its type has an order.
pub fn order(value: &Value, name: &str) -> Option<Order> {
    let inner = |key: &str| value.get(key);
    let number = |text: Option<&Value>| {
        text.and_then(Value::as_str)
            .and_then(|text| text.parse::<f64>().ok())
            .filter(|number| !number.is_nan())
            .map(Order::Number)
    };
    match name {
        "Int32" | "Int64" | "Double" | "Integer" | "Number" if value.is_number() => {
            value.as_f64().map(Order::Number)
        }
        "Int32" => number(inner("$numberInt")),
        "Int64" => number(inner("$numberLong")),
        "Double" => number(inner("$numberDouble")),
        "Decimal128" => number(inner("$numberDecimal")),
        // Canonical dates are milliseconds; relaxed ones ISO text, which sorts the same.
        "Date" => match inner("$date") {
            Some(Value::Object(long)) => number(long.get("$numberLong")),
            Some(Value::String(text)) => Some(Order::Text(text.clone())),
            _ => None,
        },
        // The hexadecimal of an ObjectId starts with its time, so it sorts by when it was made.
        "ObjectId" => inner("$oid")
            .and_then(Value::as_str)
            .map(|text| Order::Text(text.to_string())),
        "String" => value.as_str().map(|text| Order::Text(text.to_string())),
        _ => None,
    }
}

/// The length of a value whose type has one: characters of a string, items of an array.
pub fn length(value: &Value) -> Option<u64> {
    match value {
        Value::String(text) => Some(text.chars().count() as u64),
        Value::Array(items) => Some(items.len() as u64),
        _ => None,
    }
}
