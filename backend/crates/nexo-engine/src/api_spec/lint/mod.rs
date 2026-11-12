//! The linter: errors that make a definition wrong, warnings that make it hard to use.
//!
//! Each finding is `{severity, rule, params, pointer}`. The interface translates
//! `lint.<rule>` with `params`; `pointer` is where the problem is.

mod rules;

use super::{Operation, Spec, Version, operations, parameters, pointer, template_variables};
use rules::{naming, operation_rules, security};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap};

struct Findings(Vec<Value>);
impl Findings {
    fn push(&mut self, severity: &str, rule: &str, params: &[&str], at: &str) {
        self.0.push(json!({
            "severity": severity,
            "rule": rule,
            "params": params,
            "pointer": at,
        }));
    }
    fn error(&mut self, rule: &str, params: &[&str], at: &str) {
        self.push("error", rule, params, at);
    }
    fn warning(&mut self, rule: &str, params: &[&str], at: &str) {
        self.push("warning", rule, params, at);
    }
}

pub fn lint(spec: &Spec) -> Vec<Value> {
    let mut found = Findings(Vec::new());
    let root = &spec.root;
    if !root.is_object() {
        found.error("structure-root", &[], "");
        return found.0;
    }
    let version = spec.version();
    if version == Version::Unknown {
        let given = root["openapi"]
            .as_str()
            .or(root["swagger"].as_str())
            .unwrap_or("");
        found.error("version", &[given], "");
        return found.0;
    }
    structure(spec, version, &mut found);
    references(spec, &spec.root, "", &mut found);
    let operations = operations(spec);
    operation_ids(&operations, &mut found);
    for operation in &operations {
        operation_rules(spec, version, operation, &mut found);
    }
    security(spec, version, &operations, &mut found);
    naming(&operations, &mut found);
    // Errors first, then in the order of the document.
    found
        .0
        .sort_by_key(|finding| u8::from(finding["severity"] != "error"));
    found.0
}

fn structure(spec: &Spec, version: Version, found: &mut Findings) {
    let root = &spec.root;
    match root.get("info") {
        Some(info) if info.is_object() => {
            if !info["title"].is_string() {
                found.error("info-title", &[], "/info");
            }
            if !info["version"].is_string() {
                found.error("info-version", &[], "/info");
            }
        }
        _ => found.error("info-missing", &[], ""),
    }
    match root.get("paths") {
        Some(Value::Object(paths)) => {
            for path in paths.keys() {
                if !path.starts_with('/') {
                    found.error("path-slash", &[path], &pointer("/paths", path));
                }
            }
        }
        Some(_) => found.error("paths-invalid", &[], "/paths"),
        // OpenAPI 3.1 may describe only webhooks or components.
        None if version != Version::OpenApi31 => found.error("paths-missing", &[], ""),
        None => {}
    }
}

/// Every `$ref` of the document: local ones must resolve.
fn references(spec: &Spec, value: &Value, at: &str, found: &mut Findings) {
    match value {
        Value::Object(map) => {
            if let Some(reference) = map.get("$ref").and_then(Value::as_str) {
                let here = pointer(at, "$ref");
                if reference.starts_with('#') {
                    if spec.reference(reference).is_none() {
                        found.error("ref-unresolved", &[reference], &here);
                    }
                } else {
                    found.push("info", "ref-external", &[reference], &here);
                }
            }
            for (key, item) in map {
                references(spec, item, &pointer(at, key), found);
            }
        }
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                references(spec, item, &pointer(at, &index.to_string()), found);
            }
        }
        _ => {}
    }
}

fn operation_ids(operations: &[Operation], found: &mut Findings) {
    let mut seen: HashMap<&str, String> = HashMap::new();
    for operation in operations {
        let Some(id) = operation.value["operationId"].as_str() else {
            continue;
        };
        let at = pointer(&operation.pointer, "operationId");
        match seen.get(id) {
            Some(first) => {
                let first = first.clone();
                found.error("operation-id-duplicate", &[id, &first], &at);
            }
            None => {
                seen.insert(
                    id,
                    format!("{} {}", operation.method.to_uppercase(), operation.path),
                );
            }
        }
    }
}

fn successful(status: &str) -> bool {
    status.starts_with('2') && status != "204"
}
