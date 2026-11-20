//! The importers against exports of each tool (`fixtures/`), written as the tools write
//! them.

mod bruno;
mod insomnia;
mod others;

use super::super::import;
use serde_json::{Value, json};

pub(super) fn imported(content: &str) -> Value {
    import(&json!({"content": content})).unwrap()
}

/// The item at this path of names, in a collection or a folder.
pub(super) fn at<'a>(collection: &'a Value, names: &[&str]) -> &'a Value {
    names.iter().fold(collection, |group, name| {
        group["item"]
            .as_array()
            .and_then(|items| items.iter().find(|item| item["name"] == *name))
            .unwrap_or_else(|| panic!("no item {name}"))
    })
}

pub(super) fn row<'a>(rows: &'a Value, key: &str) -> &'a Value {
    rows.as_array()
        .and_then(|rows| rows.iter().find(|row| row["key"] == key))
        .map(|row| &row["value"])
        .unwrap_or(&Value::Null)
}

pub(super) fn codes(result: &Value) -> Vec<(String, String)> {
    result["report"]["notes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|note| {
            (
                note["code"].as_str().unwrap().into(),
                note["item"].as_str().unwrap().into(),
            )
        })
        .collect()
}

pub(super) fn noted(result: &Value, code: &str, item: &str) -> bool {
    codes(result).contains(&(code.to_string(), item.to_string()))
}

/// The commented script of an item, with its line that says why.
pub(super) fn script(item: &Value, listen: &str) -> String {
    item["event"]
        .as_array()
        .and_then(|events| events.iter().find(|event| event["listen"] == listen))
        .map(|event| {
            event["script"]["exec"]
                .as_array()
                .unwrap()
                .iter()
                .map(|line| line.as_str().unwrap())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}
