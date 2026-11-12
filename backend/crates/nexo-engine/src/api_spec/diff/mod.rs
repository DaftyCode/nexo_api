//! What changed between two versions of a definition, with the changes that break clients
//! marked: a removed endpoint, a new required parameter or property, a changed type, a
//! removed enum value or a removed successful response.
//!
//! Endpoints are matched by method and path, whatever their path variables are called.

mod operations;
mod schemas;

use super::{Operation, Spec, Version, operations, parameters, pointer};
use operations::compare_operation;
use schemas::{Direction, compare_schema};
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
