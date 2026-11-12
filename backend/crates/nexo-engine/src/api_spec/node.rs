//! YAML and JSON parsed into nodes that remember the line they came from.
use super::*;

/// A YAML node with the location of its children.
pub(super) enum Node {
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
pub(super) fn key_text(node: &Node) -> String {
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

pub(super) fn convert(node: Node, at: &str, lines: &mut HashMap<String, u64>) -> Value {
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
pub(super) fn remember(lines: &mut HashMap<String, u64>, pointer: &str, line: u64) {
    if line > 0 {
        lines.entry(pointer.to_string()).or_insert(line);
    }
}
