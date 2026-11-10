//! What changed between two versions of a definition, with the changes that break clients
//! marked: a removed endpoint, a new required parameter or property, a changed type, a
//! removed enum value or a removed successful response.
//!
//! Endpoints are matched by method and path, whatever their path variables are called.
use super::{Operation, Spec, Version, operations, parameters, pointer};
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// Nested schemas compared at most this deep, which also stops recursive ones.
const MAX_DEPTH: usize = 12;

/// Schemas by media type: `(media type, schema, pointer to the schema)`.
type MediaSchemas = Vec<(String, Value, String)>;

/// Which version a pointer belongs to.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Side {
    Base,
    Source,
}

struct Change {
    rule: &'static str,
    params: Vec<String>,
    breaking: bool,
    pointer: String,
    side: Side,
}

struct Changes<'a> {
    base: &'a Spec,
    source: &'a Spec,
    list: Vec<Change>,
}
impl Changes<'_> {
    fn add(&mut self, rule: &'static str, params: &[&str], breaking: bool, at: &str, side: Side) {
        self.list.push(Change {
            rule,
            params: params.iter().map(|p| p.to_string()).collect(),
            breaking,
            pointer: at.to_string(),
            side,
        });
    }
}

/// `/users/{id}` and `/users/{userId}` are the same endpoint.
fn endpoint_key(operation: &Operation) -> String {
    let mut path = String::new();
    let mut inside = false;
    for c in operation.path.chars() {
        match c {
            '{' => {
                inside = true;
                path.push_str("{}");
            }
            '}' => inside = false,
            _ if !inside => path.push(c),
            _ => {}
        }
    }
    format!("{} {path}", operation.method)
}

fn line(spec: &Spec, at: &str) -> Value {
    spec.line(at).map_or(Value::Null, |line| json!(line))
}

pub fn diff(base: &Spec, source: &Spec) -> Value {
    let old = operations(base);
    let new = operations(source);
    let endpoint = |operation: &Operation, spec: &Spec| {
        json!({
            "method": operation.method,
            "path": operation.path,
            "pointer": operation.pointer,
            "line": line(spec, &operation.pointer),
        })
    };
    let mut added = Vec::new();
    let mut removed = Vec::new();
    let mut changed = Vec::new();
    let mut breaking = 0;
    for before in &old {
        if !new
            .iter()
            .any(|after| endpoint_key(after) == endpoint_key(before))
        {
            removed.push(endpoint(before, base));
            breaking += 1;
        }
    }
    for after in &new {
        let Some(before) = old
            .iter()
            .find(|before| endpoint_key(before) == endpoint_key(after))
        else {
            added.push(endpoint(after, source));
            continue;
        };
        let mut changes = Changes {
            base,
            source,
            list: Vec::new(),
        };
        compare_operation(&mut changes, before, after);
        if changes.list.is_empty() {
            continue;
        }
        breaking += changes.list.iter().filter(|c| c.breaking).count();
        let list: Vec<Value> = changes
            .list
            .iter()
            .map(|change| {
                let spec = if change.side == Side::Base {
                    base
                } else {
                    source
                };
                json!({
                    "rule": change.rule,
                    "params": change.params,
                    "breaking": change.breaking,
                    "pointer": change.pointer,
                    "side": if change.side == Side::Base { "base" } else { "source" },
                    "line": line(spec, &change.pointer),
                })
            })
            .collect();
        let mut entry = endpoint(after, source);
        entry["changes"] = Value::Array(list);
        changed.push(entry);
    }
    json!({"breaking": breaking, "added": added, "removed": removed, "changed": changed})
}

fn compare_operation(changes: &mut Changes, before: &Operation, after: &Operation) {
    let (base, source) = (changes.base, changes.source);
    // Parameters, by location and name. A path variable is matched by position.
    let old_parameters = parameters(base, before);
    let new_parameters = parameters(source, after);
    let old_variables = super::template_variables(before.path);
    let new_variables = super::template_variables(after.path);
    let same = |old: &super::Parameter, new: &super::Parameter| {
        old.location == new.location
            && (old.name == new.name
                || (old.location == "path"
                    && old_variables.iter().position(|v| *v == old.name)
                        == new_variables.iter().position(|v| *v == new.name)))
    };
    for new in new_parameters.iter().filter(|p| p.location != "body") {
        let required = new.value["required"] == true;
        match old_parameters.iter().find(|old| same(old, new)) {
            None if required => changes.add(
                "parameter-added-required",
                &[new.location, new.name],
                true,
                &new.pointer,
                Side::Source,
            ),
            None => changes.add(
                "parameter-added",
                &[new.location, new.name],
                false,
                &new.pointer,
                Side::Source,
            ),
            Some(old) => {
                if required && old.value["required"] != true {
                    changes.add(
                        "parameter-required",
                        &[new.location, new.name],
                        true,
                        &new.pointer,
                        Side::Source,
                    );
                }
                let schema = |spec: &Spec, parameter: &super::Parameter| {
                    if spec.version() == Version::Swagger2 {
                        (parameter.value.clone(), parameter.pointer.clone())
                    } else {
                        (
                            parameter.value["schema"].clone(),
                            pointer(&parameter.pointer, "schema"),
                        )
                    }
                };
                let (old_schema, old_at) = schema(base, old);
                let (new_schema, new_at) = schema(source, new);
                let place = format!("{} {}", new.location, new.name);
                compare_schema(
                    changes,
                    (&old_schema, &old_at),
                    (&new_schema, &new_at),
                    &place,
                    Direction::Request,
                    0,
                );
            }
        }
    }
    for old in old_parameters.iter().filter(|p| p.location != "body") {
        if !new_parameters.iter().any(|new| same(old, new)) {
            changes.add(
                "parameter-removed",
                &[old.location, old.name],
                false,
                &old.pointer,
                Side::Base,
            );
        }
    }
    compare_bodies(changes, before, after);
    compare_responses(changes, before, after);
}

/// The request body schemas by media type, with the pointer to each, and whether required.
fn bodies(spec: &Spec, operation: &Operation) -> (MediaSchemas, bool, String) {
    if spec.version() == Version::Swagger2 {
        let body = parameters(spec, operation)
            .into_iter()
            .find(|p| p.location == "body");
        return match body {
            Some(body) => (
                vec![(
                    "body".into(),
                    body.value["schema"].clone(),
                    pointer(&body.pointer, "schema"),
                )],
                body.value["required"] == true,
                body.pointer,
            ),
            None => (Vec::new(), false, String::new()),
        };
    }
    let Some(raw) = operation.value.get("requestBody") else {
        return (Vec::new(), false, String::new());
    };
    let (body, at) = spec.resolve(raw, &pointer(&operation.pointer, "requestBody"));
    let content_at = pointer(&at, "content");
    let media = body["content"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(media, value)| {
            (
                media.clone(),
                value["schema"].clone(),
                pointer(&pointer(&content_at, media), "schema"),
            )
        })
        .collect();
    (media, body["required"] == true, at)
}

fn compare_bodies(changes: &mut Changes, before: &Operation, after: &Operation) {
    let (old, old_required, old_at) = bodies(changes.base, before);
    let (new, new_required, new_at) = bodies(changes.source, after);
    match (old.is_empty(), new.is_empty()) {
        (true, true) => return,
        (true, false) => {
            changes.add("body-added", &[], new_required, &new_at, Side::Source);
            return;
        }
        (false, true) => {
            changes.add("body-removed", &[], false, &old_at, Side::Base);
            return;
        }
        _ => {}
    }
    if new_required && !old_required {
        changes.add("body-required", &[], true, &new_at, Side::Source);
    }
    // Swagger 2 has one body whatever its media type.
    let single = old.len() == 1 && new.len() == 1 && (old[0].0 == "body" || new[0].0 == "body");
    for (media, schema, at) in &old {
        let found = if single {
            new.first()
        } else {
            new.iter().find(|(name, _, _)| name == media)
        };
        match found {
            None => changes.add("body-media-removed", &[media], true, at, Side::Base),
            Some((_, new_schema, new_at)) => compare_schema(
                changes,
                (schema, at),
                (new_schema, new_at),
                &format!("body {media}"),
                Direction::Request,
                0,
            ),
        }
    }
}

/// The responses by status, with their schemas by media type.
fn responses(spec: &Spec, operation: &Operation) -> Vec<(String, String, MediaSchemas)> {
    let at = pointer(&operation.pointer, "responses");
    operation.value["responses"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(status, raw)| {
            let (response, place) = spec.resolve(raw, &pointer(&at, status));
            let schemas = if spec.version() == Version::Swagger2 {
                response
                    .get("schema")
                    .map(|schema| {
                        vec![(
                            "body".to_string(),
                            schema.clone(),
                            pointer(&place, "schema"),
                        )]
                    })
                    .unwrap_or_default()
            } else {
                response["content"]
                    .as_object()
                    .into_iter()
                    .flatten()
                    .map(|(media, value)| {
                        (
                            media.clone(),
                            value["schema"].clone(),
                            pointer(&pointer(&pointer(&place, "content"), media), "schema"),
                        )
                    })
                    .collect()
            };
            (status.clone(), place, schemas)
        })
        .collect()
}

fn compare_responses(changes: &mut Changes, before: &Operation, after: &Operation) {
    let old = responses(changes.base, before);
    let new = responses(changes.source, after);
    for (status, at, schemas) in &old {
        match new.iter().find(|(s, _, _)| s == status) {
            None => changes.add(
                "response-removed",
                &[status],
                status.starts_with('2'),
                at,
                Side::Base,
            ),
            Some((_, _, new_schemas)) => {
                let single = schemas.len() == 1 && new_schemas.len() == 1;
                for (media, schema, schema_at) in schemas {
                    let found = if single && (media == "body" || new_schemas[0].0 == "body") {
                        new_schemas.first()
                    } else {
                        new_schemas.iter().find(|(name, _, _)| name == media)
                    };
                    match found {
                        None => changes.add(
                            "response-media-removed",
                            &[status, media],
                            status.starts_with('2'),
                            schema_at,
                            Side::Base,
                        ),
                        Some((_, new_schema, new_at)) => compare_schema(
                            changes,
                            (schema, schema_at),
                            (new_schema, new_at),
                            &format!("response {status}"),
                            Direction::Response,
                            0,
                        ),
                    }
                }
            }
        }
    }
    for (status, at, _) in &new {
        if !old.iter().any(|(s, _, _)| s == status) {
            changes.add("response-added", &[status], false, at, Side::Source);
        }
    }
}

/// Who sends the data: a request schema may not demand more, a response may not give less.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Direction {
    Request,
    Response,
}

fn types(schema: &Value) -> BTreeSet<String> {
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
fn joined(set: &BTreeSet<String>) -> String {
    set.iter().cloned().collect::<Vec<_>>().join(" | ")
}

fn compare_schema(
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
