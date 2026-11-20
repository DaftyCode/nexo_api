//! Data masking (`masking` documents): rules that hide or replace sensitive fields before
//! data leaves Nexo, in an export, to an MCP agent or to the AI assistant. A rule names
//! fields as the comparison of responses does (`email` at any depth, `$.card.number` from
//! the top, `*` and `**`), ignoring case and, unless it names items, the arrays on the way;
//! the first rule that names a field masks it whole.
//!
//! Hashes and synthetic values come from a keyed hash the caller gives (the engine keeps
//! its key in the vault): the same value always becomes the same token or the same
//! synthetic value, so masked data still joins, and nobody without the key can go back.
mod rules;
mod synthetic;
#[cfg(test)]
mod tests;

pub use rules::{MAX_KEEP, MAX_RULES, Method, Rules};
pub use synthetic::{FIRST_NAMES, LAST_NAMES, synthetic};

use crate::Result;
use crate::diff::Segment;
use rules::Rule;
use serde_json::{Map, Value};

/// Characters of a token (`hash`), as hexadecimal.
const TOKEN: usize = 16;
/// What `hide` writes, and what `truncate` writes before the characters it keeps.
pub const HIDDEN: &str = "****";

/// A keyed hash: 32 bytes for a text, always the same for the same text.
pub type Digest<'a> = &'a dyn Fn(&[u8]) -> [u8; 32];

/// Checks the value of a `masking` document.
pub fn validate(value: &Value) -> Result<()> {
    Rules::read(value).map(|_| ())
}

/// Whether a set also masks what MCP agents and the AI assistant read.
pub fn for_agents(value: &Value) -> bool {
    value.get("agents").and_then(Value::as_bool) == Some(true)
}

/// Masks data with a set of rules and a keyed hash.
pub struct Masker<'a> {
    rules: &'a Rules,
    digest: Digest<'a>,
}

impl<'a> Masker<'a> {
    pub fn new(rules: &'a Rules, digest: Digest<'a>) -> Self {
        Self { rules, digest }
    }

    /// Masks a document (any JSON value) in place.
    pub fn document(&self, value: &mut Value) {
        self.walk(value, &mut Vec::new());
    }

    /// Masks rows of a table: each column is a field of the top level. Returns the
    /// positions of the columns kept; the removed ones are left out of every row.
    pub fn rows(&self, columns: &[String], rows: &mut [Vec<Value>]) -> Vec<usize> {
        let rules: Vec<Option<&Rule>> = columns
            .iter()
            .map(|name| self.rules.find(&[Segment::Key(name.to_lowercase())]))
            .collect();
        for row in rows.iter_mut() {
            for ((cell, rule), name) in row.iter_mut().zip(&rules).zip(columns) {
                if let Some(rule) = rule.filter(|rule| rule.method != Method::Remove) {
                    *cell = self.apply(rule, cell, name);
                }
            }
        }
        let kept: Vec<usize> = rules
            .iter()
            .enumerate()
            .filter(|(_, rule)| !rule.is_some_and(|rule| rule.method == Method::Remove))
            .map(|(at, _)| at)
            .collect();
        if kept.len() < columns.len() {
            for row in rows.iter_mut() {
                let cells = std::mem::take(row);
                *row = cells
                    .into_iter()
                    .enumerate()
                    .filter(|(at, _)| kept.contains(at))
                    .map(|(_, cell)| cell)
                    .collect();
            }
        }
        kept
    }

    fn walk(&self, value: &mut Value, path: &mut Vec<Segment>) {
        match value {
            Value::Object(fields) => {
                let mut removed = Vec::new();
                for (name, field) in fields.iter_mut() {
                    path.push(Segment::Key(name.to_lowercase()));
                    match self.rules.find(path) {
                        Some(rule) if rule.method == Method::Remove => removed.push(name.clone()),
                        Some(rule) => *field = self.apply(rule, field, name),
                        None => self.walk(field, path),
                    }
                    path.pop();
                }
                for name in removed {
                    fields.remove(&name);
                }
            }
            Value::Array(items) => {
                // Items are named after the field that holds them.
                let name = path
                    .iter()
                    .rev()
                    .find_map(|segment| match segment {
                        Segment::Key(key) => Some(key.clone()),
                        Segment::Index(_) => None,
                    })
                    .unwrap_or_default();
                let mut kept = Vec::with_capacity(items.len());
                for (index, mut item) in std::mem::take(items).into_iter().enumerate() {
                    path.push(Segment::Index(index));
                    match self.rules.find(path) {
                        Some(rule) if rule.method == Method::Remove => {}
                        Some(rule) => kept.push(self.apply(rule, &item, &name)),
                        None => {
                            self.walk(&mut item, path);
                            kept.push(item);
                        }
                    }
                    path.pop();
                }
                *items = kept;
            }
            _ => {}
        }
    }

    /// The masked form of a field's value; `NULL` stays `NULL`, it reveals nothing.
    fn apply(&self, rule: &Rule, value: &Value, name: &str) -> Value {
        if value.is_null() {
            return Value::Null;
        }
        match rule.method {
            Method::Hide | Method::Remove => Value::String(HIDDEN.into()),
            Method::Truncate => {
                let text = plain_text(value);
                let count = text.chars().count();
                if rule.keep == 0 || count <= rule.keep {
                    Value::String(HIDDEN.into())
                } else {
                    let tail: String = text.chars().skip(count - rule.keep).collect();
                    Value::String(format!("{HIDDEN} {tail}"))
                }
            }
            Method::Hash => {
                let bytes = (self.digest)(value.to_string().as_bytes());
                let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
                Value::String(hex[..TOKEN].to_string())
            }
            Method::Synthetic => synthetic(value, name, self.digest),
        }
    }
}

/// A value as text: a string as it is, a typed value (`{"$t": "integer", "v": "7"}`,
/// `{"$numberLong": "7"}`) by its inner value, anything else as JSON.
fn plain_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Object(fields) => match inner(fields) {
            Some(inner) => plain_text(inner),
            None => value.to_string(),
        },
        other => other.to_string(),
    }
}

/// The value inside a typed value of a database: `v` next to `$t`, or the only `$` field.
fn inner(fields: &Map<String, Value>) -> Option<&Value> {
    if fields.contains_key("$t") {
        return fields.get("v");
    }
    match fields.iter().next() {
        Some((key, value)) if fields.len() == 1 && key.starts_with('$') => Some(value),
        _ => None,
    }
}
