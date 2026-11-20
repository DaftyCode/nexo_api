//! The keywords of a schema, checked against a value.
use super::super::formats::matches;
use super::containers::{arrays, objects};
use super::{Checker, PatternCheck};
use serde_json::{Map, Value};

/// Two JSON values alike, numbers by their value (`1` is `1.0`).
pub(super) fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same(a, b))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(key, a)| y.get(key).is_some_and(|b| same(a, b)))
        }
        _ => a == b,
    }
}

fn is_type(value: &Value, name: &str) -> bool {
    match name {
        "null" => value.is_null(),
        "boolean" => value.is_boolean(),
        "string" => value.is_string(),
        "array" => value.is_array(),
        "object" => value.is_object(),
        "number" => value.is_number(),
        "integer" => value.as_f64().is_some_and(|n| n.fract() == 0.0),
        _ => true,
    }
}

fn json_kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

pub(super) fn number(rules: &Map<String, Value>, key: &str) -> Option<f64> {
    rules.get(key).and_then(Value::as_f64)
}

pub(super) fn count(rules: &Map<String, Value>, key: &str) -> Option<usize> {
    rules.get(key).and_then(Value::as_u64).map(|n| n as usize)
}

pub(super) fn child(path: &str, key: &str) -> String {
    let plain = !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_alphanumeric() || c == '_' || c == '$');
    if plain {
        format!("{path}.{key}")
    } else {
        format!("{path}[{}]", Value::from(key))
    }
}

pub(super) fn check<'a>(
    checker: &mut Checker<'a>,
    rules: &'a Map<String, Value>,
    value: &Value,
    path: &str,
) {
    if let Some(types) = rules.get("type") {
        let names: Vec<&str> = match types {
            Value::String(name) => vec![name.as_str()],
            Value::Array(names) => names.iter().filter_map(Value::as_str).collect(),
            _ => Vec::new(),
        };
        // OpenAPI 3.0 writes `nullable: true` for a value that may also be null.
        let nullable = rules.get("nullable") == Some(&Value::Bool(true)) && value.is_null();
        if !names.is_empty() && !nullable && !names.iter().any(|name| is_type(value, name)) {
            checker.problem(
                path,
                format!("Expected {}, got {}", names.join(" or "), json_kind(value)),
            );
        }
    }
    if let Some(Value::Array(allowed)) = rules.get("enum")
        && !allowed.iter().any(|item| same(item, value))
    {
        checker.problem(
            path,
            format!(
                "Expected one of {}, got {value}",
                Value::from(allowed.clone())
            ),
        );
    }
    if let Some(constant) = rules.get("const")
        && !same(constant, value)
    {
        checker.problem(path, format!("Expected {constant}, got {value}"));
    }
    match value {
        Value::Number(_) => numbers(checker, rules, value.as_f64().unwrap_or(0.0), path),
        Value::String(text) => strings(checker, rules, text, path),
        Value::Array(items) => arrays(checker, rules, items, path),
        Value::Object(fields) => objects(checker, rules, fields, path),
        _ => {}
    }
    combinations(checker, rules, value, path);
}

fn numbers(checker: &mut Checker, rules: &Map<String, Value>, n: f64, path: &str) {
    // Drafts 4 and earlier write the exclusive limits as booleans beside the limit.
    let exclusive = |key: &str| rules.get(key) == Some(&Value::Bool(true));
    if let Some(min) = number(rules, "minimum") {
        if exclusive("exclusiveMinimum") && n <= min {
            checker.problem(path, format!("Expected a number above {min}, got {n}"));
        } else if n < min {
            checker.problem(path, format!("Expected at least {min}, got {n}"));
        }
    }
    if let Some(max) = number(rules, "maximum") {
        if exclusive("exclusiveMaximum") && n >= max {
            checker.problem(path, format!("Expected a number below {max}, got {n}"));
        } else if n > max {
            checker.problem(path, format!("Expected at most {max}, got {n}"));
        }
    }
    if let Some(min) = number(rules, "exclusiveMinimum")
        && n <= min
    {
        checker.problem(path, format!("Expected a number above {min}, got {n}"));
    }
    if let Some(max) = number(rules, "exclusiveMaximum")
        && n >= max
    {
        checker.problem(path, format!("Expected a number below {max}, got {n}"));
    }
    if let Some(step) = number(rules, "multipleOf").filter(|step| *step > 0.0) {
        let quotient = n / step;
        if (quotient - quotient.round()).abs() > 1e-9 {
            checker.problem(path, format!("Expected a multiple of {step}, got {n}"));
        }
    }
}

fn strings(checker: &mut Checker, rules: &Map<String, Value>, text: &str, path: &str) {
    let length = text.chars().count();
    if let Some(min) = count(rules, "minLength").filter(|min| length < *min) {
        checker.problem(
            path,
            format!("Expected at least {min} characters, got {length}"),
        );
    }
    if let Some(max) = count(rules, "maxLength").filter(|max| length > *max) {
        checker.problem(
            path,
            format!("Expected at most {max} characters, got {length}"),
        );
    }
    if let Some(format) = rules.get("format").and_then(Value::as_str)
        && !matches(format, text)
    {
        checker.problem(
            path,
            format!("Expected the format {format}, got {}", Value::from(text)),
        );
    }
    if let Some(pattern) = rules.get("pattern").and_then(Value::as_str)
        && checker.patterns
    {
        checker.result.patterns.push(PatternCheck {
            path: path.to_string(),
            pattern: pattern.to_string(),
            value: text.to_string(),
        });
    }
}

fn combinations<'a>(
    checker: &mut Checker<'a>,
    rules: &'a Map<String, Value>,
    value: &Value,
    path: &str,
) {
    for schema in rules
        .get("allOf")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        checker.check(schema, value, path);
    }
    if let Some(Value::Array(any)) = rules.get("anyOf")
        && !any.iter().any(|schema| checker.passes(schema, value))
    {
        checker.problem(
            path,
            "Expected the value to match at least one schema of anyOf",
        );
    }
    if let Some(Value::Array(one)) = rules.get("oneOf") {
        let matched = one
            .iter()
            .filter(|schema| checker.passes(schema, value))
            .count();
        if matched != 1 {
            checker.problem(
                path,
                format!("Expected the value to match one schema of oneOf, it matches {matched}"),
            );
        }
    }
    if let Some(not) = rules.get("not")
        && checker.passes(not, value)
    {
        checker.problem(path, "Expected the value not to match the schema of not");
    }
    if let Some(condition) = rules.get("if") {
        let branch = if checker.passes(condition, value) {
            "then"
        } else {
            "else"
        };
        if let Some(schema) = rules.get(branch) {
            checker.check(schema, value, path);
        }
    }
}
