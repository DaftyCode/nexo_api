//! The linter: errors that make a definition wrong, warnings that make it hard to use.
//!
//! Each finding is `{severity, rule, params, pointer}`. The interface translates
//! `lint.<rule>` with `params`; `pointer` is where the problem is.
use super::{Operation, Spec, Version, operations, parameters, pointer, template_variables};
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

fn operation_rules(spec: &Spec, version: Version, operation: &Operation, found: &mut Findings) {
    let label = format!("{} {}", operation.method.to_uppercase(), operation.path);
    let parameters = parameters(spec, operation);
    let valid_locations: &[&str] = if version == Version::Swagger2 {
        &["query", "header", "path", "formData", "body"]
    } else {
        &["query", "header", "path", "cookie"]
    };
    for parameter in &parameters {
        if parameter.name.is_empty() || parameter.location.is_empty() {
            found.error("parameter-invalid", &[&label], &parameter.pointer);
            continue;
        }
        if !valid_locations.contains(&parameter.location) {
            found.error(
                "parameter-location",
                &[parameter.name, parameter.location],
                &parameter.pointer,
            );
        }
        if parameter.location == "path" && parameter.value["required"] != true {
            found.error(
                "path-parameter-required",
                &[parameter.name],
                &parameter.pointer,
            );
        }
    }
    // Path parameters: each `{name}` declared, and each declared one in the template.
    let variables = template_variables(operation.path);
    for variable in &variables {
        if !parameters
            .iter()
            .any(|p| p.location == "path" && p.name == *variable)
        {
            found.error(
                "path-parameter-missing",
                &[variable, &label],
                &operation.pointer,
            );
        }
    }
    for parameter in parameters.iter().filter(|p| p.location == "path") {
        if !variables.contains(&parameter.name) {
            found.error(
                "path-parameter-unused",
                &[parameter.name, operation.path],
                &parameter.pointer,
            );
        }
    }
    let responses_at = pointer(&operation.pointer, "responses");
    match operation.value["responses"].as_object() {
        Some(responses) if !responses.is_empty() => {
            for (status, response) in responses {
                let at = pointer(&responses_at, status);
                let (response, at) = spec.resolve(response, &at);
                response_rules(spec, version, status, response, &at, found);
            }
        }
        _ => found.error("operation-responses", &[&label], &operation.pointer),
    }
    if !operation.value["summary"].is_string() && !operation.value["description"].is_string() {
        found.warning("operation-summary", &[&label], &operation.pointer);
    }
}

fn successful(status: &str) -> bool {
    status.starts_with('2') && status != "204"
}

/// Successful responses describe their body and show an example of it.
fn response_rules(
    spec: &Spec,
    version: Version,
    status: &str,
    response: &Value,
    at: &str,
    found: &mut Findings,
) {
    if !successful(status) {
        return;
    }
    let has_example = |schema: &Value, schema_at: &str| {
        let (schema, _) = spec.resolve(schema, schema_at);
        schema.get("example").is_some() || schema.get("examples").is_some()
    };
    if version == Version::Swagger2 {
        match response.get("schema") {
            None => found.warning("response-schema", &[status, ""], at),
            Some(schema) => {
                if response.get("examples").is_none() && !has_example(schema, at) {
                    found.warning("response-example", &[status, ""], at);
                }
            }
        }
        return;
    }
    let Some(content) = response["content"].as_object() else {
        return;
    };
    for (media, body) in content {
        let media_at = pointer(&pointer(at, "content"), media);
        match body.get("schema") {
            None => found.warning("response-schema", &[status, media], &media_at),
            Some(schema) => {
                if body.get("example").is_none()
                    && body.get("examples").is_none()
                    && !has_example(schema, &pointer(&media_at, "schema"))
                {
                    found.warning("response-example", &[status, media], &media_at);
                }
            }
        }
    }
}

/// Security requirements name schemes the document defines.
fn security(spec: &Spec, version: Version, operations: &[Operation], found: &mut Findings) {
    let defined: BTreeSet<&str> = if version == Version::Swagger2 {
        &spec.root["securityDefinitions"]
    } else {
        &spec.root["components"]["securitySchemes"]
    }
    .as_object()
    .map(|schemes| schemes.keys().map(String::as_str).collect())
    .unwrap_or_default();
    let mut check = |requirements: &Value, at: &str| {
        for (index, requirement) in requirements.as_array().into_iter().flatten().enumerate() {
            for name in requirement.as_object().into_iter().flat_map(|r| r.keys()) {
                if !defined.contains(name.as_str()) {
                    found.error(
                        "security-undefined",
                        &[name],
                        &pointer(&pointer(at, &index.to_string()), name),
                    );
                }
            }
        }
    };
    check(&spec.root["security"], "/security");
    for operation in operations {
        check(
            &operation.value["security"],
            &pointer(&operation.pointer, "security"),
        );
    }
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Style {
    Camel,
    Snake,
    Kebab,
}
impl Style {
    fn of(name: &str) -> Option<Style> {
        if name.contains('_') {
            Some(Style::Snake)
        } else if name.contains('-') {
            Some(Style::Kebab)
        } else if name.chars().next().is_some_and(char::is_lowercase)
            && name.chars().any(char::is_uppercase)
        {
            Some(Style::Camel)
        } else {
            // One lowercase word fits every style.
            None
        }
    }
    fn label(self) -> &'static str {
        match self {
            Style::Camel => "camelCase",
            Style::Snake => "snake_case",
            Style::Kebab => "kebab-case",
        }
    }
}
/// Operation IDs follow the style most of them use.
fn naming(operations: &[Operation], found: &mut Findings) {
    let styled: Vec<(&Operation, &str, Style)> = operations
        .iter()
        .filter_map(|operation| {
            let id = operation.value["operationId"].as_str()?;
            Some((operation, id, Style::of(id)?))
        })
        .collect();
    let mut counts: BTreeMap<Style, usize> = BTreeMap::new();
    for (_, _, style) in &styled {
        *counts.entry(*style).or_default() += 1;
    }
    let Some((&dominant, _)) = counts.iter().max_by_key(|(_, count)| **count) else {
        return;
    };
    if counts.len() < 2 {
        return;
    }
    for (operation, id, style) in styled {
        if style != dominant {
            found.warning(
                "operation-id-style",
                &[id, dominant.label()],
                &pointer(&operation.pointer, "operationId"),
            );
        }
    }
}
