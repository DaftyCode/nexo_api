//! Two tables compared part by part, from their models (`ddl.model` of DB-19): the columns
//! (type, nulls, default, identity, comment), the primary key, unique keys, checks, foreign
//! keys and indexes. Between engines, types are compared by what they hold and index
//! methods are left out.
use super::pairs::{columns, columns_of, default_of, expression, key_of, list, pair, text};
use super::types::{Status, type_status};
use super::{Difference, Options, Part};
use serde_json::Value;

fn column_fields(a: &Value, b: &Value, options: &Options) -> (Vec<&'static str>, bool) {
    let mut fields = Vec::new();
    let mut equivalent = false;
    match type_status(
        &text(a, "typeName"),
        &text(b, "typeName"),
        options.source,
        options.target,
    ) {
        Status::Equal => {}
        Status::Equivalent => equivalent = true,
        _ => fields.push("type"),
    }
    if a["nullable"] != b["nullable"] {
        fields.push("nullable");
    }
    if default_of(a) != default_of(b) && !(a["identity"] == true && b["identity"] == true) {
        fields.push("default");
    }
    if a["identity"].as_bool().unwrap_or(false) != b["identity"].as_bool().unwrap_or(false) {
        fields.push("identity");
    }
    if !options.ignore_comments && a["comment"] != b["comment"] {
        fields.push("comment");
    }
    (fields, equivalent)
}

/// How the parts of two tables differ; nothing when they are the same.
pub fn compare_tables(source: &Value, target: &Value, options: &Options) -> Vec<Difference> {
    let mut out = Vec::new();
    let name = |value: &Value| key_of(&text(value, "name"), options);
    pair(
        Part::Column,
        &list(source, "columns"),
        &list(target, "columns"),
        name,
        |a, b| column_fields(a, b, options),
        &mut out,
    );
    let common: Vec<String> = columns_of(source, options);
    if !options.ignore_column_order {
        let order = |value: &Value| -> Vec<String> {
            list(value, "columns")
                .iter()
                .map(|column| key_of(&text(column, "name"), options))
                .filter(|name| common.contains(name) && columns_of(target, options).contains(name))
                .collect()
        };
        if order(source) != order(target) {
            out.push(Difference::new(
                Part::Table,
                "",
                Status::Different,
                vec!["columnOrder"],
                &Value::Null,
                &Value::Null,
            ));
        }
    }
    // The primary key: one at most on each side.
    let primary = |value: &Value| match &value["primaryKey"] {
        Value::Object(_) => vec![value["primaryKey"].clone()],
        _ => vec![],
    };
    let names = !options.ignore_constraint_names;
    let keyed = |by_name: bool, signature: fn(&Value, &Options) -> String| {
        move |value: &Value| {
            if by_name && !text(value, "name").is_empty() {
                key_of(&text(value, "name"), options)
            } else {
                signature(value, options)
            }
        }
    };
    let key_columns =
        |value: &Value, options: &Options| columns(value, "columns", options).join(",");
    let compare_columns = |a: &Value, b: &Value| {
        let mut fields = Vec::new();
        if columns(a, "columns", options) != columns(b, "columns", options) {
            fields.push("columns");
        }
        if names && key_of(&text(a, "name"), options) != key_of(&text(b, "name"), options) {
            fields.push("name");
        }
        (fields, false)
    };
    // A table has one primary key whatever its name: its name differing is noted, not missing.
    pair(
        Part::PrimaryKey,
        &primary(source),
        &primary(target),
        |_| String::new(),
        compare_columns,
        &mut out,
    );
    pair(
        Part::Unique,
        &list(source, "uniques"),
        &list(target, "uniques"),
        keyed(names, key_columns),
        compare_columns,
        &mut out,
    );
    let check_signature = |value: &Value, _: &Options| expression(&text(value, "expression"));
    pair(
        Part::Check,
        &list(source, "checks"),
        &list(target, "checks"),
        keyed(names, check_signature),
        |a, b| {
            let same = expression(&text(a, "expression")) == expression(&text(b, "expression"));
            (if same { vec![] } else { vec!["expression"] }, false)
        },
        &mut out,
    );
    let foreign_signature = |value: &Value, options: &Options| {
        format!(
            "{}>{}({})",
            columns(value, "columns", options).join(","),
            key_of(&text(value, "referencedTable"), options),
            columns(value, "referencedColumns", options).join(",")
        )
    };
    pair(
        Part::ForeignKey,
        &list(source, "foreignKeys"),
        &list(target, "foreignKeys"),
        keyed(names, foreign_signature),
        |a, b| {
            let mut fields = Vec::new();
            if foreign_signature(a, options) != foreign_signature(b, options) {
                fields.push("references");
            }
            let action =
                |value: &Value, key| text(value, key).to_uppercase().replace("NO ACTION", "");
            if action(a, "onDelete") != action(b, "onDelete")
                || action(a, "onUpdate") != action(b, "onUpdate")
            {
                fields.push("actions");
            }
            (fields, false)
        },
        &mut out,
    );
    let index_signature = |value: &Value, options: &Options| {
        format!(
            "{}{}",
            columns(value, "columns", options).join(","),
            if value["unique"] == true { "!" } else { "" }
        )
    };
    pair(
        Part::Index,
        &list(source, "indexes"),
        &list(target, "indexes"),
        keyed(names, index_signature),
        |a, b| {
            let mut fields = Vec::new();
            if columns(a, "columns", options) != columns(b, "columns", options) {
                fields.push("columns");
            }
            if a["unique"].as_bool().unwrap_or(false) != b["unique"].as_bool().unwrap_or(false) {
                fields.push("unique");
            }
            let method = |value: &Value| text(value, "method").to_lowercase().replace("btree", "");
            if !options.between() && method(a) != method(b) {
                fields.push("method");
            }
            if expression(&text(a, "condition")) != expression(&text(b, "condition")) {
                fields.push("condition");
            }
            (fields, false)
        },
        &mut out,
    );
    if !options.ignore_comments && source["comment"] != target["comment"] {
        out.push(Difference::new(
            Part::Table,
            "",
            Status::Different,
            vec!["comment"],
            &source["comment"],
            &target["comment"],
        ));
    }
    out
}
