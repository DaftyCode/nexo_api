//! The source's tables made the target's: between two engines their types become the
//! target's and what is written for the other engine is left out, with a warning; and the
//! order that creates first the tables others refer to.
use super::super::Entry;
use nexo_domain::sql::{Dialect, SourceColumn, compare::kind_of, convert};
use serde_json::{Value, json};

/// A warning of the script: the text of the catalogs and the value it says.
pub(super) fn warning(text: &str, value: &str) -> Value {
    json!({"text": text, "params": {"v0": value}})
}

/// The source's model of a table made the target's: its schema, its name and, between two
/// engines, its types.
pub(super) fn adapted(
    model: &Value,
    schema: Option<&str>,
    name: &str,
    from: Dialect,
    to: Dialect,
    warnings: &mut Vec<Value>,
) -> Value {
    let mut model = model.clone();
    let source_schema = model["schema"].as_str().map(String::from);
    model["schema"] = json!(schema);
    model["name"] = json!(name);
    model["original"] = json!("");
    for key in model["foreignKeys"].as_array_mut().into_iter().flatten() {
        if key["referencedSchema"].as_str().is_some()
            && key["referencedSchema"].as_str().map(String::from) == source_schema
        {
            key["referencedSchema"] = json!(schema);
        }
    }
    if from == to {
        return model;
    }
    for column in model["columns"].as_array_mut().into_iter().flatten() {
        let type_name = column["typeName"].as_str().unwrap_or_default().to_string();
        let source = SourceColumn {
            name: String::new(),
            kind: kind_of(&type_name).into(),
            type_name,
            nullable: None,
        };
        column["typeName"] = json!(convert(&source, from, to).sql_type);
        if column.get("default").is_some_and(|value| !value.is_null()) {
            let named = format!("{name}.{}", column["name"].as_str().unwrap_or_default());
            warnings.push(warning("db.compare.warn.default", &named));
            column["default"] = Value::Null;
        }
    }
    if model["checks"]
        .as_array()
        .is_some_and(|checks| !checks.is_empty())
    {
        warnings.push(warning("db.compare.warn.checks", name));
        model["checks"] = json!([]);
    }
    for index in model["indexes"].as_array_mut().into_iter().flatten() {
        index["method"] = json!("");
        index["condition"] = json!("");
    }
    model
}

/// The tables a table refers to with its foreign keys.
fn references(model: &Value) -> Vec<String> {
    model["foreignKeys"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|key| key["referencedTable"].as_str().map(str::to_lowercase))
        .collect()
}

/// Tables to create in an order that makes each one after those it refers to.
pub(super) fn ordered(entries: Vec<&Entry>) -> Vec<&Entry> {
    let mut pending = entries;
    let mut done: Vec<&Entry> = Vec::new();
    while !pending.is_empty() {
        let names: Vec<String> = pending
            .iter()
            .map(|e| {
                e.models.0["name"]
                    .as_str()
                    .unwrap_or_default()
                    .to_lowercase()
            })
            .collect();
        let ready = pending.iter().position(|entry| {
            let own = entry.models.0["name"]
                .as_str()
                .unwrap_or_default()
                .to_lowercase();
            references(&entry.models.0)
                .iter()
                .all(|table| *table == own || !names.contains(table))
        });
        // A cycle of references: the rest goes as it is (the script says the order may fail).
        done.push(pending.remove(ready.unwrap_or(0)));
    }
    done
}
