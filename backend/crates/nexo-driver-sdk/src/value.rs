//! Values and columns of a result, written so that no type is lost between the server and
//! the interface.
//!
//! What JSON holds without loss travels as JSON: `null`, booleans, text, integers within
//! ±(2^53 − 1) and finite numbers. Everything else is `{"$t": "<kind>", "v": …}`: 64-bit
//! integers beyond that range, decimals, dates, intervals, binary data in Base64, UUIDs,
//! JSON documents (as their text) and arrays. A value cut to fit the limits also says
//! `"truncated": true` and its full `"size"`.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};

/// What a value is, whatever its database calls it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ValueKind {
    Text,
    Integer,
    Decimal,
    Float,
    Boolean,
    Date,
    Time,
    Timestamp,
    /// A timestamp with its time zone or offset.
    Timestamptz,
    Interval,
    /// In Base64.
    Binary,
    /// A JSON document, as its text.
    Json,
    Xml,
    Uuid,
    Array,
    /// A geometry, as WKT or as WKB in hexadecimal.
    Spatial,
    Other,
}

/// The largest integer a JSON number holds exactly in every reader (2^53 − 1).
pub const SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(into = "Json", try_from = "Json")]
pub enum Value {
    Null,
    Bool(bool),
    Integer(i64),
    Float(f64),
    Text(String),
    /// A value written as text, with what it is.
    Typed {
        kind: ValueKind,
        text: String,
        /// The size of the whole value when `text` is only its beginning.
        full_size: Option<u64>,
    },
    Array(Vec<Value>),
}

impl Value {
    pub fn typed(kind: ValueKind, text: impl Into<String>) -> Self {
        Self::Typed {
            kind,
            text: text.into(),
            full_size: None,
        }
    }
    pub fn bytes(bytes: &[u8]) -> Self {
        Self::typed(ValueKind::Binary, STANDARD.encode(bytes))
    }
    /// The bytes of a binary value.
    pub fn as_bytes(&self) -> Option<Vec<u8>> {
        match self {
            Self::Typed {
                kind: ValueKind::Binary,
                text,
                ..
            } => STANDARD.decode(text).ok(),
            _ => None,
        }
    }
    /// The value cut to `limit` bytes of text, saying how long it was. Text is cut at a
    /// character; other kinds are left whole unless they are text-like.
    pub fn truncated(self, limit: usize) -> Self {
        let (kind, text) = match self {
            Self::Text(text) => (ValueKind::Text, text),
            Self::Typed {
                kind,
                text,
                full_size: None,
            } if matches!(kind, ValueKind::Json | ValueKind::Xml | ValueKind::Other) => {
                (kind, text)
            }
            other => return other,
        };
        if text.len() <= limit {
            return match kind {
                ValueKind::Text => Self::Text(text),
                kind => Self::typed(kind, text),
            };
        }
        let mut end = limit;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        Self::Typed {
            kind,
            full_size: Some(text.len() as u64),
            text: text[..end].to_owned(),
        }
    }
}

impl From<Value> for Json {
    fn from(value: Value) -> Self {
        match value {
            Value::Null => Json::Null,
            Value::Bool(value) => Json::Bool(value),
            Value::Integer(value) if (-SAFE_INTEGER..=SAFE_INTEGER).contains(&value) => {
                json!(value)
            }
            Value::Integer(value) => json!({"$t": ValueKind::Integer, "v": value.to_string()}),
            Value::Float(value) if value.is_finite() => json!(value),
            // NaN and the infinities have no JSON number.
            Value::Float(value) => json!({"$t": ValueKind::Float, "v": value.to_string()}),
            Value::Text(text) => Json::String(text),
            Value::Typed {
                kind,
                text,
                full_size: None,
            } => json!({"$t": kind, "v": text}),
            Value::Typed {
                kind,
                text,
                full_size: Some(size),
            } => json!({"$t": kind, "v": text, "truncated": true, "size": size}),
            Value::Array(items) => {
                let items: Vec<Json> = items.into_iter().map(Json::from).collect();
                json!({"$t": ValueKind::Array, "v": items})
            }
        }
    }
}

impl TryFrom<Json> for Value {
    type Error = String;
    fn try_from(json: Json) -> Result<Self, String> {
        Ok(match json {
            Json::Null => Self::Null,
            Json::Bool(value) => Self::Bool(value),
            Json::String(text) => Self::Text(text),
            Json::Number(number) => match number.as_i64() {
                Some(integer) => Self::Integer(integer),
                None => Self::Float(number.as_f64().ok_or("a number out of range")?),
            },
            Json::Array(_) => return Err("an array without its kind".into()),
            Json::Object(mut object) => {
                let kind: ValueKind =
                    serde_json::from_value(object.remove("$t").ok_or("a value without $t")?)
                        .map_err(|_| "an unknown kind of value")?;
                let value = object.remove("v").ok_or("a value without v")?;
                let full_size = object.remove("size").and_then(|size| size.as_u64());
                match (kind, value) {
                    (ValueKind::Array, Json::Array(items)) => Self::Array(
                        items
                            .into_iter()
                            .map(Self::try_from)
                            .collect::<Result<_, _>>()?,
                    ),
                    (ValueKind::Array, _) => return Err("an array without its items".into()),
                    (ValueKind::Integer, Json::String(text)) if full_size.is_none() => {
                        Self::Integer(text.parse().map_err(|_| "an integer out of range")?)
                    }
                    (ValueKind::Float, Json::String(text)) if full_size.is_none() => {
                        Self::Float(text.parse().map_err(|_| "not a number")?)
                    }
                    (kind, Json::String(text)) => Self::Typed {
                        kind,
                        text,
                        full_size,
                    },
                    _ => return Err("the value of a kind is not text".into()),
                }
            }
        })
    }
}

/// Where a column of a result comes from, when the server says: what makes a result
/// editable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Origin {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub table: String,
    pub column: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub name: String,
    /// The type as the database names it (`numeric(10,2)`, `varchar`, `timestamptz`).
    pub type_name: String,
    pub kind: ValueKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nullable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<Origin>,
    /// Part of a key that identifies the row.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub key: bool,
}
impl Column {
    pub fn new(name: impl Into<String>, type_name: impl Into<String>, kind: ValueKind) -> Self {
        Self {
            name: name.into(),
            type_name: type_name.into(),
            kind,
            nullable: None,
            origin: None,
            key: false,
        }
    }
}
