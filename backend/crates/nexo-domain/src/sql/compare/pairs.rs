//! What the comparison of two tables pairs and reads: the items of both sides paired by what
//! they hold or by name, and the texts, names and defaults as they are compared.
use super::types::Status;
use super::values::number;
use super::{Difference, Options, Part};
use serde_json::Value;

pub(super) fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_string()
}

pub(super) fn list(value: &Value, key: &str) -> Vec<Value> {
    value[key].as_array().cloned().unwrap_or_default()
}

/// A name as it is matched: as written in one engine, without case between two.
pub(super) fn key_of(name: &str, options: &Options) -> String {
    if options.between() {
        name.to_lowercase()
    } else {
        name.to_string()
    }
}

/// The names of columns as they are matched, in order.
pub(super) fn columns(value: &Value, key: &str, options: &Options) -> Vec<String> {
    list(value, key)
        .iter()
        .filter_map(Value::as_str)
        .map(|name| key_of(name, options))
        .collect()
}

/// A default as compared: without casts (`'x'::text`), outer parentheses, quotes of a plain
/// number, or case; `NULL` is no default.
pub(super) fn default_of(value: &Value) -> Option<String> {
    let text = value["default"].as_str()?.trim();
    let mut text = text.to_lowercase();
    while text.starts_with('(') && text.ends_with(')') {
        text = text[1..text.len() - 1].trim().to_string();
    }
    if let Some(cast) = text.find("::") {
        text.truncate(cast);
    }
    let text = text.trim().to_string();
    let unquoted = text.trim_matches('\'');
    let text = if unquoted.parse::<f64>().is_ok() {
        number(unquoted)
    } else {
        text
    };
    (text != "null").then_some(text)
}

/// An expression as compared: no case, quotes or spaces.
pub(super) fn expression(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .filter(|c| !c.is_whitespace() && !matches!(c, '"' | '`' | '[' | ']' | '(' | ')'))
        .collect()
}

/// Pairs the items of both sides by `key` (or, failing that, by their name) and says how each
/// pair stands.
pub(super) fn pair(
    part: Part,
    source: &[Value],
    target: &[Value],
    key: impl Fn(&Value) -> String,
    fields: impl Fn(&Value, &Value) -> (Vec<&'static str>, bool),
    out: &mut Vec<Difference>,
) {
    let named = |value: &Value| text(value, "name").to_lowercase();
    let mut paired = vec![false; target.len()];
    let mut matches = Vec::new();
    for a in source {
        let by_key = (0..target.len()).find(|&at| !paired[at] && key(&target[at]) == key(a));
        let by_name = || {
            (0..target.len())
                .find(|&at| !paired[at] && !named(a).is_empty() && named(&target[at]) == named(a))
        };
        let found = by_key.or_else(by_name);
        if let Some(at) = found {
            paired[at] = true;
        }
        matches.push((a, found));
    }
    for (a, found) in matches {
        let name = text(a, "name");
        match found {
            None => out.push(Difference::new(
                part,
                &name,
                Status::OnlySource,
                vec![],
                a,
                &Value::Null,
            )),
            Some(at) => {
                let b = &target[at];
                let (changed, equivalent) = fields(a, b);
                let status = match (changed.is_empty(), equivalent) {
                    (false, _) => Status::Different,
                    (true, true) => Status::Equivalent,
                    (true, false) => continue,
                };
                out.push(Difference::new(part, &name, status, changed, a, b));
            }
        }
    }
    for (b, _) in target.iter().zip(&paired).filter(|(_, paired)| !**paired) {
        out.push(Difference::new(
            part,
            &text(b, "name"),
            Status::OnlyTarget,
            vec![],
            &Value::Null,
            b,
        ));
    }
}

pub(super) fn columns_of(value: &Value, options: &Options) -> Vec<String> {
    list(value, "columns")
        .iter()
        .map(|column| key_of(&text(column, "name"), options))
        .collect()
}
