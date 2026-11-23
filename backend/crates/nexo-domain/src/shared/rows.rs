//! Joining two people's changes to the variables of an environment, row by row.
use serde_json::{Map, Value};
use std::collections::HashSet;

/// Joins two people's changes to a list of rows with a `key` (the variables of an
/// environment): what only one side changed is taken; what both changed keeps theirs.
pub fn merge_rows(base: &Value, ours: &Value, theirs: &Value) -> Value {
    let rows = |value: &Value| -> Vec<(String, Value)> {
        value
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|row| Some((row["key"].as_str()?.to_owned(), row.clone())))
            .collect()
    };
    let as_map =
        |rows: &[(String, Value)]| -> Map<String, Value> { rows.iter().cloned().collect() };
    let (before, mine, other) = (as_map(&rows(base)), rows(ours), rows(theirs));
    let mine_map = as_map(&mine);
    let mut joined = Vec::new();
    let mut seen = HashSet::new();
    for (key, _) in other.iter().chain(mine.iter()) {
        if !seen.insert(key.clone()) {
            continue;
        }
        let (old, m, t) = (
            before.get(key),
            mine_map.get(key),
            other.iter().find(|(k, _)| k == key).map(|(_, row)| row),
        );
        let chosen = match (m, t) {
            (Some(m), Some(t)) => Some(if old == Some(t) { m } else { t }),
            (Some(only), None) | (None, Some(only)) => (old != Some(only)).then_some(only),
            (None, None) => None,
        };
        if let Some(chosen) = chosen {
            joined.push(chosen.clone());
        }
    }
    Value::Array(joined)
}
