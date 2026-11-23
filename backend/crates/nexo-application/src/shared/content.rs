//! What a shared collection carries, and what comes back of it: the variables of an
//! environment without their secret values, a joined collection with this Nexo's own
//! credentials and settings, the element of a collection by its id, and the environments of
//! both sides joined.
use crate::mcp;
use nexo_domain::{Error, shared};
use serde_json::{Map, Value, json};
use std::collections::HashSet;

fn secret_row(row: &Value) -> bool {
    row["type"] == "secret" || mcp::sensitive_name(row["key"].as_str().unwrap_or_default())
}

/// The variables of an environment as they may be shared: secret values left out.
pub(super) fn shared_rows(values: &Value) -> Value {
    let rows = values.as_array().into_iter().flatten().map(|row| {
        let mut row = row.clone();
        let value = row["value"].as_str().unwrap_or_default();
        if secret_row(&row) && !mcp::is_reference(value) {
            row["value"] = json!("");
        }
        row
    });
    Value::Array(rows.collect())
}

/// The joined variables with this Nexo's own secret values.
pub(super) fn restore_rows(joined: &Value, local: &Value) -> Value {
    let rows = joined.as_array().into_iter().flatten().map(|row| {
        let mine = local
            .as_array()
            .into_iter()
            .flatten()
            .find(|own| own["key"] == row["key"]);
        match mine {
            Some(mine) if row["value"] == "" && (secret_row(mine) || secret_row(row)) => {
                let mut row = row.clone();
                row["value"] = mine["value"].clone();
                row
            }
            _ => row.clone(),
        }
    });
    Value::Array(rows.collect())
}

/// The element of `local` that a joined one stands for: the same id, the same key, or the
/// same place.
fn twin<'a>(item: &Value, local: &'a [Value], index: usize) -> &'a Value {
    for field in ["id", "key"] {
        if let Some(wanted) = item[field].as_str() {
            return local
                .iter()
                .find(|own| own[field].as_str() == Some(wanted))
                .unwrap_or(&Value::Null);
        }
    }
    local.get(index).unwrap_or(&Value::Null)
}

/// The joined collection with this Nexo's own credentials, where the file has them masked,
/// and the settings of this computer.
pub(super) fn restore(joined: &Value, local: &Value) -> Value {
    match (joined, local) {
        (Value::String(text), original) if text == mcp::MASKED && !original.is_null() => {
            original.clone()
        }
        (Value::Object(fields), Value::Object(original)) => {
            let mut restored: Map<String, Value> = fields
                .iter()
                .map(|(name, item)| {
                    (
                        name.clone(),
                        restore(item, original.get(name).unwrap_or(&Value::Null)),
                    )
                })
                .collect();
            for name in mcp::LOCAL_SETTINGS {
                if let Some(kept) = original.get(name).filter(|_| !restored.contains_key(name)) {
                    restored.insert(name.into(), kept.clone());
                }
            }
            Value::Object(restored)
        }
        (Value::Array(items), Value::Array(original)) => Value::Array(
            items
                .iter()
                .enumerate()
                .map(|(index, item)| restore(item, twin(item, original, index)))
                .collect(),
        ),
        (other, _) => other.clone(),
    }
}

/// An element of a collection by its id (the collection itself for `""`), without its items.
pub(super) fn element(collection: &Value, id: &str) -> Option<Value> {
    fn find<'a>(items: &'a Value, id: &str) -> Option<&'a Value> {
        items.as_array()?.iter().find_map(|item| {
            if item["id"].as_str() == Some(id) {
                Some(item)
            } else {
                find(&item["item"], id)
            }
        })
    }
    let found = if id.is_empty() {
        collection
    } else {
        find(&collection["item"], id)?
    };
    let mut content = found.clone();
    if let Value::Object(fields) = &mut content {
        fields.remove("item");
    }
    Some(content)
}

/// The environments of both sides joined: each one's variables by key.
pub(super) fn merge_environments(base: &Value, ours: &Value, theirs: &Value) -> Value {
    let find = |list: &Value, id: &Value| {
        list.as_array()
            .into_iter()
            .flatten()
            .find(|env| env["id"] == *id)
            .cloned()
    };
    let mut seen = HashSet::new();
    let mut joined = Vec::new();
    for env in theirs
        .as_array()
        .into_iter()
        .flatten()
        .chain(ours.as_array().into_iter().flatten())
    {
        if !seen.insert(env["id"].to_string()) {
            continue;
        }
        let (before, mine, other) = (
            find(base, &env["id"]),
            find(ours, &env["id"]),
            find(theirs, &env["id"]),
        );
        let values =
            |side: &Option<Value>| side.as_ref().map_or(json!([]), |env| env["values"].clone());
        let name = other
            .as_ref()
            .or(mine.as_ref())
            .map_or(Value::Null, |env| env["name"].clone());
        let rows = shared::merge_rows(&values(&before), &values(&mine), &values(&other));
        joined.push(json!({"id": env["id"], "name": name, "values": rows}));
    }
    Value::Array(joined)
}

pub(super) fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64)
}

pub(super) fn locked() -> Error {
    Error::Validation("This shared collection is encrypted: paste its team key".into())
}
