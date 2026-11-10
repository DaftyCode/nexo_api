//! OpenAPI 3.0/3.1 and Swagger 2.0 definitions: a linter, a diff that marks breaking changes,
//! and an outline for the explorer. Every result carries a JSON pointer and, when the source
//! gives one, the line it starts at, so the editor can go there.
//!
//! The definition is read as YAML (JSON is YAML too) with the location of every node; when
//! that fails, as JSON without lines.
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

/// A YAML node with the location of its children.
enum Node {
    Null,
    Bool(bool),
    Int(i64),
    UInt(u64),
    Float(f64),
    Text(String),
    Seq(Vec<Spanned<Node>>),
    Map(Vec<(Spanned<Node>, Spanned<Node>)>),
}
impl<'de> Deserialize<'de> for Node {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct NodeVisitor;
        impl<'de> Visitor<'de> for NodeVisitor {
            type Value = Node;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a YAML value")
            }
            fn visit_bool<E: de::Error>(self, value: bool) -> std::result::Result<Node, E> {
                Ok(Node::Bool(value))
            }
            fn visit_i64<E: de::Error>(self, value: i64) -> std::result::Result<Node, E> {
                Ok(Node::Int(value))
            }
            fn visit_u64<E: de::Error>(self, value: u64) -> std::result::Result<Node, E> {
                Ok(Node::UInt(value))
            }
            fn visit_f64<E: de::Error>(self, value: f64) -> std::result::Result<Node, E> {
                Ok(Node::Float(value))
            }
            fn visit_str<E: de::Error>(self, value: &str) -> std::result::Result<Node, E> {
                Ok(Node::Text(value.into()))
            }
            fn visit_string<E: de::Error>(self, value: String) -> std::result::Result<Node, E> {
                Ok(Node::Text(value))
            }
            fn visit_unit<E: de::Error>(self) -> std::result::Result<Node, E> {
                Ok(Node::Null)
            }
            fn visit_none<E: de::Error>(self) -> std::result::Result<Node, E> {
                Ok(Node::Null)
            }
            fn visit_some<D: Deserializer<'de>>(
                self,
                deserializer: D,
            ) -> std::result::Result<Node, D::Error> {
                Node::deserialize(deserializer)
            }
            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> std::result::Result<Node, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element::<Spanned<Node>>()? {
                    items.push(item);
                }
                Ok(Node::Seq(items))
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut map: A,
            ) -> std::result::Result<Node, A::Error> {
                let mut entries = Vec::new();
                while let Some(key) = map.next_key::<Spanned<Node>>()? {
                    entries.push((key, map.next_value::<Spanned<Node>>()?));
                }
                Ok(Node::Map(entries))
            }
        }
        deserializer.deserialize_any(NodeVisitor)
    }
}
fn key_text(node: &Node) -> String {
    match node {
        Node::Text(text) => text.clone(),
        Node::Int(value) => value.to_string(),
        Node::UInt(value) => value.to_string(),
        Node::Float(value) => value.to_string(),
        Node::Bool(value) => value.to_string(),
        _ => String::new(),
    }
}

/// Escapes one segment of a JSON pointer.
pub(crate) fn escape(segment: &str) -> String {
    segment.replace('~', "~0").replace('/', "~1")
}
pub(crate) fn pointer(parent: &str, segment: &str) -> String {
    format!("{parent}/{}", escape(segment))
}

fn convert(node: Node, at: &str, lines: &mut HashMap<String, u64>) -> Value {
    match node {
        Node::Null => Value::Null,
        Node::Bool(value) => json!(value),
        Node::Int(value) => json!(value),
        Node::UInt(value) => json!(value),
        Node::Float(value) => json!(value),
        Node::Text(text) => json!(text),
        Node::Seq(items) => Value::Array(
            items
                .into_iter()
                .enumerate()
                .map(|(index, item)| {
                    let child = pointer(at, &index.to_string());
                    remember(lines, &child, item.referenced.line());
                    convert(item.value, &child, lines)
                })
                .collect(),
        ),
        Node::Map(entries) => {
            let mut map = Map::new();
            for (key, value) in entries {
                let name = key_text(&key.value);
                let child = pointer(at, &name);
                // The line of the key, where the entry starts.
                remember(lines, &child, key.referenced.line());
                map.insert(name, convert(value.value, &child, lines));
            }
            Value::Object(map)
        }
    }
}
fn remember(lines: &mut HashMap<String, u64>, pointer: &str, line: u64) {
    if line > 0 {
        lines.entry(pointer.to_string()).or_insert(line);
    }
}

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

/// HTTP methods of a path item.
pub(crate) const METHODS: [&str; 8] = [
    "get", "put", "post", "delete", "options", "head", "patch", "trace",
];

/// An operation of the definition.
pub(crate) struct Operation<'a> {
    pub path: &'a str,
    pub method: &'static str,
    pub pointer: String,
    pub value: &'a Value,
    pub item: &'a Value,
    pub item_pointer: String,
}
pub(crate) fn operations(spec: &Spec) -> Vec<Operation<'_>> {
    let mut found = Vec::new();
    let Some(paths) = spec.root["paths"].as_object() else {
        return found;
    };
    for (path, item) in paths {
        let at = pointer("/paths", path);
        let (item, item_pointer) = spec.resolve(item, &at);
        for method in METHODS {
            if let Some(value) = item.get(method).filter(|value| value.is_object()) {
                found.push(Operation {
                    path,
                    method,
                    pointer: pointer(&item_pointer, method),
                    value,
                    item,
                    item_pointer: item_pointer.clone(),
                });
            }
        }
    }
    found
}

/// A parameter of an operation, with path-level ones it does not override.
pub(crate) struct Parameter<'a> {
    pub name: &'a str,
    pub location: &'a str,
    pub value: &'a Value,
    pub pointer: String,
}
pub(crate) fn parameters<'a>(spec: &'a Spec, operation: &Operation<'a>) -> Vec<Parameter<'a>> {
    let read = |list: &'a Value, at: &str| -> Vec<Parameter<'a>> {
        list.as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .map(|(index, raw)| {
                let (value, place) = spec.resolve(raw, &pointer(at, &index.to_string()));
                Parameter {
                    name: value["name"].as_str().unwrap_or(""),
                    location: value["in"].as_str().unwrap_or(""),
                    value,
                    pointer: place,
                }
            })
            .collect()
    };
    let own = read(
        &operation.value["parameters"],
        &pointer(&operation.pointer, "parameters"),
    );
    let mut all: Vec<Parameter<'a>> = read(
        &operation.item["parameters"],
        &pointer(&operation.item_pointer, "parameters"),
    )
    .into_iter()
    .filter(|shared| {
        !own.iter()
            .any(|p| p.name == shared.name && p.location == shared.location)
    })
    .collect();
    all.extend(own);
    all
}

/// The variables of a path template: `/users/{id}` has `id`.
pub(crate) fn template_variables(path: &str) -> Vec<&str> {
    path.split('{')
        .skip(1)
        .filter_map(|part| part.split_once('}').map(|(name, _)| name))
        .collect()
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
