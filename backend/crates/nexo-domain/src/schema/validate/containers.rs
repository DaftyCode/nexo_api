//! The keywords of arrays (`items`, `prefixItems`, `contains`, their limits) and of objects
//! (`properties`, `required`, `additionalProperties`, their limits).
use super::Checker;
use super::keywords::{child, count, same};
use serde_json::{Map, Value};

pub(super) fn arrays<'a>(
    checker: &mut Checker<'a>,
    rules: &'a Map<String, Value>,
    items: &[Value],
    path: &str,
) {
    if let Some(min) = count(rules, "minItems").filter(|min| items.len() < *min) {
        checker.problem(
            path,
            format!("Expected at least {min} items, got {}", items.len()),
        );
    }
    if let Some(max) = count(rules, "maxItems").filter(|max| items.len() > *max) {
        checker.problem(
            path,
            format!("Expected at most {max} items, got {}", items.len()),
        );
    }
    if rules.get("uniqueItems") == Some(&Value::Bool(true)) {
        let repeated =
            (1..items.len()).find(|&at| items[..at].iter().any(|before| same(before, &items[at])));
        if let Some(at) = repeated {
            checker.problem(&format!("{path}[{at}]"), "Expected the items to be unique");
        }
    }
    // `prefixItems` (2020-12), or `items` as a list (drafts 4 to 2019-09), for the first ones.
    let prefix = match (rules.get("prefixItems"), rules.get("items")) {
        (Some(Value::Array(prefix)), _) | (None, Some(Value::Array(prefix))) => prefix.as_slice(),
        _ => &[],
    };
    for (at, (schema, item)) in prefix.iter().zip(items).enumerate() {
        checker.check(schema, item, &format!("{path}[{at}]"));
    }
    let rest = match (rules.get("items"), rules.get("additionalItems")) {
        (Some(items @ (Value::Object(_) | Value::Bool(_))), _) => Some(items),
        (Some(Value::Array(_)), Some(additional)) => Some(additional),
        _ => None,
    };
    if let Some(schema) = rest {
        for (at, item) in items.iter().enumerate().skip(prefix.len()) {
            checker.check(schema, item, &format!("{path}[{at}]"));
        }
    }
    if let Some(contains) = rules.get("contains") {
        let found = items
            .iter()
            .filter(|item| checker.passes(contains, item))
            .count();
        let min = count(rules, "minContains").unwrap_or(1);
        if found < min {
            checker.problem(
                path,
                format!("Expected at least {min} items to match `contains`, got {found}"),
            );
        }
        if let Some(max) = count(rules, "maxContains").filter(|max| found > *max) {
            checker.problem(
                path,
                format!("Expected at most {max} items to match `contains`, got {found}"),
            );
        }
    }
}

pub(super) fn objects<'a>(
    checker: &mut Checker<'a>,
    rules: &'a Map<String, Value>,
    fields: &Map<String, Value>,
    path: &str,
) {
    if let Some(Value::Array(required)) = rules.get("required") {
        for name in required.iter().filter_map(Value::as_str) {
            if !fields.contains_key(name) {
                checker.problem(
                    path,
                    format!("Missing required property {}", Value::from(name)),
                );
            }
        }
    }
    if let Some(min) = count(rules, "minProperties").filter(|min| fields.len() < *min) {
        checker.problem(
            path,
            format!("Expected at least {min} properties, got {}", fields.len()),
        );
    }
    if let Some(max) = count(rules, "maxProperties").filter(|max| fields.len() > *max) {
        checker.problem(
            path,
            format!("Expected at most {max} properties, got {}", fields.len()),
        );
    }
    if let Some(Value::Object(dependent)) = rules.get("dependentRequired") {
        for (name, needs) in dependent
            .iter()
            .filter(|(name, _)| fields.contains_key(*name))
        {
            for need in needs
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                if !fields.contains_key(need) {
                    checker.problem(path, format!("Property {need} is required with {name}"));
                }
            }
        }
    }
    let properties = rules.get("properties").and_then(Value::as_object);
    for (name, value) in fields {
        let path = child(path, name);
        match properties.and_then(|properties| properties.get(name)) {
            Some(schema) => checker.check(schema, value, &path),
            // With `patternProperties`, which fields they name is not known here: the others
            // are not checked against `additionalProperties`.
            None if rules.contains_key("patternProperties") => {}
            None => match rules.get("additionalProperties") {
                Some(Value::Bool(false)) => checker.problem(&path, "This property is not allowed"),
                Some(schema @ Value::Object(_)) => checker.check(schema, value, &path),
                _ => {}
            },
        }
    }
}
