//! What changed in a schema, and whether the change breaks requests or responses.
use super::*;

/// Who sends the data: a request schema may not demand more, a response may not give less.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Direction {
    Request,
    Response,
}

pub(super) fn types(schema: &Value) -> BTreeSet<String> {
    match &schema["type"] {
        Value::String(kind) => BTreeSet::from([kind.clone()]),
        Value::Array(kinds) => kinds
            .iter()
            .filter_map(Value::as_str)
            .map(String::from)
            .collect(),
        _ => BTreeSet::new(),
    }
}
pub(super) fn joined(set: &BTreeSet<String>) -> String {
    set.iter().cloned().collect::<Vec<_>>().join(" | ")
}

pub(super) fn compare_schema(
    changes: &mut Changes,
    (old, old_at): (&Value, &str),
    (new, new_at): (&Value, &str),
    place: &str,
    direction: Direction,
    depth: usize,
) {
    if depth > MAX_DEPTH {
        return;
    }
    let (old, old_at) = changes.base.resolve(old, old_at);
    let (new, new_at) = changes.source.resolve(new, new_at);
    let (old_types, new_types) = (types(old), types(new));
    if !old_types.is_empty() && !new_types.is_empty() && old_types != new_types {
        changes.add(
            "schema-type",
            &[place, &joined(&old_types), &joined(&new_types)],
            true,
            &new_at,
            Side::Source,
        );
        return;
    }
    if let (Some(old_values), Some(new_values)) = (old["enum"].as_array(), new["enum"].as_array()) {
        let gone: Vec<String> = old_values
            .iter()
            .filter(|value| !new_values.contains(value))
            .map(|value| {
                value
                    .as_str()
                    .map_or_else(|| value.to_string(), String::from)
            })
            .collect();
        if !gone.is_empty() {
            changes.add(
                "enum-removed",
                &[place, &gone.join(", ")],
                true,
                &new_at,
                Side::Source,
            );
        }
    }
    let required = |schema: &Value| -> BTreeSet<String> {
        schema["required"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(String::from)
            .collect()
    };
    let (old_required, new_required) = (required(old), required(new));
    let old_properties = old["properties"].as_object();
    let new_properties = new["properties"].as_object();
    if let Some(new_properties) = new_properties {
        let properties_at = pointer(&new_at, "properties");
        for (name, schema) in new_properties {
            let at = pointer(&properties_at, name);
            let child = format!("{place}.{name}");
            match old_properties.and_then(|old| old.get(name)) {
                None => {
                    let demanded = direction == Direction::Request && new_required.contains(name);
                    changes.add(
                        if demanded {
                            "property-added-required"
                        } else {
                            "property-added"
                        },
                        &[&child],
                        demanded,
                        &at,
                        Side::Source,
                    );
                }
                Some(old_schema) => {
                    if direction == Direction::Request
                        && new_required.contains(name)
                        && !old_required.contains(name)
                    {
                        changes.add("property-required", &[&child], true, &at, Side::Source);
                    }
                    let old_child_at = pointer(&pointer(&old_at, "properties"), name);
                    compare_schema(
                        changes,
                        (old_schema, &old_child_at),
                        (schema, &at),
                        &child,
                        direction,
                        depth + 1,
                    );
                }
            }
        }
    }
    if let Some(old_properties) = old_properties {
        for name in old_properties.keys() {
            if new_properties.is_none_or(|new| !new.contains_key(name)) {
                let child = format!("{place}.{name}");
                changes.add(
                    "property-removed",
                    &[&child],
                    direction == Direction::Response,
                    &pointer(&pointer(&old_at, "properties"), name),
                    Side::Base,
                );
            }
        }
    }
    if old.get("items").is_some() && new.get("items").is_some() {
        compare_schema(
            changes,
            (&old["items"], &pointer(&old_at, "items")),
            (&new["items"], &pointer(&new_at, "items")),
            &format!("{place}[]"),
            direction,
            depth + 1,
        );
    }
}
