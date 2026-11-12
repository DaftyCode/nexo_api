//! OpenAPI 3.0/3.1 and Swagger 2.0 definitions: a linter, a diff that marks breaking changes,
//! and an outline for the explorer. Every result carries a JSON pointer and, when the source
//! gives one, the line it starts at, so the editor can go there.
//!
//! The definition is read as YAML (JSON is YAML too) with the location of every node; when
//! that fails, as JSON without lines.

mod node;
mod paths;
pub(crate) use node::pointer;
use node::{Node, convert, remember};
pub(crate) use paths::{Operation, Parameter, operations, parameters, template_variables};

mod diff;
mod lint;
mod outline;
#[cfg(test)]
mod tests;

use nexo_domain::{Error, Result};
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value, json};
use serde_saphyr::Spanned;
use std::{collections::HashMap, fmt};

/// Definitions larger than this are not analysed.
const MAX_SOURCE: usize = 8 * 1024 * 1024;
/// `$ref` chains longer than this are treated as cycles.
const MAX_REFS: usize = 32;

/// The kind of definition, from its `openapi` or `swagger` field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Version {
    Swagger2,
    OpenApi30,
    OpenApi31,
    Unknown,
}
impl Version {
    pub fn label(self) -> &'static str {
        match self {
            Version::Swagger2 => "2.0",
            Version::OpenApi30 => "3.0",
            Version::OpenApi31 => "3.1",
            Version::Unknown => "",
        }
    }
}

/// A parsed definition with the line of each node.
pub struct Spec {
    pub root: Value,
    lines: HashMap<String, u64>,
}
impl Spec {
    pub fn parse(source: &str) -> Result<Spec> {
        if source.len() > MAX_SOURCE {
            return Err(Error::Validation(
                "The definition is larger than 8 MB".into(),
            ));
        }
        match serde_saphyr::from_str::<Spanned<Node>>(source) {
            Ok(root) => {
                let mut lines = HashMap::new();
                remember(&mut lines, "", root.referenced.line());
                let root = convert(root.value, "", &mut lines);
                Ok(Spec { root, lines })
            }
            Err(yaml) => serde_json::from_str::<Value>(source)
                .map(|root| Spec {
                    root,
                    lines: HashMap::new(),
                })
                .map_err(|_| Error::Validation(format!("{yaml}"))),
        }
    }
    #[cfg(test)]
    pub fn from_value(root: Value) -> Spec {
        Spec {
            root,
            lines: HashMap::new(),
        }
    }
    /// The line of a node, or of its closest ancestor that has one.
    pub fn line(&self, pointer: &str) -> Option<u64> {
        let mut current = pointer;
        loop {
            if let Some(line) = self.lines.get(current) {
                return Some(*line);
            }
            let (parent, _) = current.rsplit_once('/')?;
            current = parent;
        }
    }
    pub fn version(&self) -> Version {
        if self.root["swagger"].as_str() == Some("2.0") {
            return Version::Swagger2;
        }
        match self.root["openapi"].as_str() {
            Some(version) if version.starts_with("3.0") => Version::OpenApi30,
            Some(version) if version.starts_with("3.") => Version::OpenApi31,
            _ => Version::Unknown,
        }
    }
    /// The node at a local reference (`#/components/schemas/User`).
    pub fn reference(&self, reference: &str) -> Option<&Value> {
        let fragment = reference.strip_prefix('#')?;
        let decoded = percent_decode(fragment);
        if decoded.is_empty() {
            return Some(&self.root);
        }
        self.root.pointer(&decoded)
    }
    /// A value with its local `$ref` followed, and the pointer it ends at.
    pub fn resolve<'a>(&'a self, value: &'a Value, at: &str) -> (&'a Value, String) {
        let mut current = value;
        let mut place = at.to_string();
        for _ in 0..MAX_REFS {
            let Some(reference) = current["$ref"].as_str() else {
                break;
            };
            match self.reference(reference) {
                Some(target) => {
                    current = target;
                    place = percent_decode(reference.trim_start_matches('#'));
                }
                None => break,
            }
        }
        (current, place)
    }
}
fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && let Some(byte) = text
                .get(index + 1..index + 3)
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
        {
            out.push(byte);
            index += 3;
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Adds the line of every `pointer` field that has none, for the editor.
fn with_lines(value: &mut Value, spec: &Spec) {
    match value {
        Value::Object(map) => {
            if let Some(at) = map.get("pointer").and_then(Value::as_str)
                && !map.contains_key("line")
                && let Some(line) = spec.line(at)
            {
                map.insert("line".into(), json!(line));
            }
            for item in map.values_mut() {
                with_lines(item, spec);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|item| with_lines(item, spec)),
        _ => {}
    }
}

/// The line of a parse error, read from its message.
fn error_line(message: &str) -> Option<u64> {
    let lower = message.to_ascii_lowercase();
    let at = lower.find("line ")?;
    lower[at + 5..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .ok()
}

/// `api.inspect`: the findings of the linter and the outline of a definition.
pub fn inspect(payload: &Value) -> Result<Value> {
    let source = payload["source"].as_str().unwrap_or("");
    let spec = match Spec::parse(source) {
        Ok(spec) => spec,
        Err(Error::Validation(message)) => {
            let mut finding = json!({
                "severity": "error",
                "rule": "parse",
                "params": [message],
                "pointer": "",
            });
            if let Some(line) = error_line(&message) {
                finding["line"] = json!(line);
            }
            return Ok(json!({"version": "", "findings": [finding], "outline": Value::Null}));
        }
        Err(other) => return Err(other),
    };
    let mut result = json!({
        "version": spec.version().label(),
        "findings": lint::lint(&spec),
        "outline": outline::outline(&spec),
    });
    with_lines(&mut result, &spec);
    Ok(result)
}

/// `api.diff`: what changed from `base` to `source`, with the breaking changes marked.
pub fn compare(payload: &Value) -> Result<Value> {
    let parse = |field: &str| {
        Spec::parse(payload[field].as_str().unwrap_or("")).map_err(|error| match error {
            Error::Validation(message) => Error::Validation(format!(
                "The {} definition cannot be read: {message}",
                if field == "base" {
                    "earlier"
                } else {
                    "current"
                }
            )),
            other => other,
        })
    };
    let (base, source) = (parse("base")?, parse("source")?);
    Ok(diff::diff(&base, &source))
}
