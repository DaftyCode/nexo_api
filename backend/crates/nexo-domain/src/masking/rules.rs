//! The rules of a `masking` document: the fields each one names and what it does with them.
use crate::diff::{Pattern, Segment};
use crate::{Error, Result};
use serde_json::Value;

/// Rules of one set, at most.
pub const MAX_RULES: usize = 200;
/// Characters of a rule's path, at most.
const MAX_PATH: usize = 300;
/// Characters `truncate` keeps at most, and by default.
pub const MAX_KEEP: usize = 12;
const DEFAULT_KEEP: usize = 4;

/// What a rule does with the fields it names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    /// `****`.
    Hide,
    /// `**** 1234`: the last characters, the rest hidden.
    Truncate,
    /// A token from a keyed hash: the same value, the same token.
    Hash,
    /// A made-up value of the same form: an email, a name, digits for digits.
    Synthetic,
    /// The field is left out.
    Remove,
}

impl Method {
    pub const ALL: [Method; 5] = [
        Self::Hide,
        Self::Truncate,
        Self::Hash,
        Self::Synthetic,
        Self::Remove,
    ];
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hide => "hide",
            Self::Truncate => "truncate",
            Self::Hash => "hash",
            Self::Synthetic => "synthetic",
            Self::Remove => "remove",
        }
    }
    pub fn parse(text: &str) -> Result<Self> {
        Self::ALL
            .into_iter()
            .find(|method| method.as_str() == text)
            .ok_or_else(|| {
                Error::Validation(
                    "A masking rule hides, truncates, hashes, makes up or removes its field".into(),
                )
            })
    }
}

#[derive(Debug, Clone)]
pub(super) struct Rule {
    pattern: Pattern,
    /// Whether the pattern names items (`[0]`, `[*]`): then arrays count in the path.
    items: bool,
    pub(super) method: Method,
    pub(super) keep: usize,
}

/// The rules of a `masking` document, in order.
#[derive(Debug, Clone, Default)]
pub struct Rules(Vec<Rule>);

impl Rules {
    /// Reads `{"rules": [{"path": "email", "method": "hash"}, {"path": "card.number",
    /// "method": "truncate", "keep": 4}]}`; rules without a path are skipped.
    pub fn read(value: &Value) -> Result<Self> {
        let Some(list) = value.get("rules").and_then(Value::as_array) else {
            return Err(Error::Validation("A masking set needs a rule list".into()));
        };
        if list.len() > MAX_RULES {
            return Err(Error::Validation(format!(
                "A masking set has {MAX_RULES} rules at most"
            )));
        }
        let mut rules = Vec::new();
        for rule in list {
            let path = rule
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if path.is_empty() {
                continue;
            }
            if path.chars().count() > MAX_PATH {
                return Err(Error::Validation(format!(
                    "A masking path has {MAX_PATH} characters at most"
                )));
            }
            let pattern = Pattern::parse(&path.to_lowercase())
                .map_err(|_| Error::Validation(format!("Invalid masking path: {path}")))?;
            let method = Method::parse(rule.get("method").and_then(Value::as_str).unwrap_or(""))?;
            let keep = match rule.get("keep") {
                None | Some(Value::Null) => DEFAULT_KEEP,
                Some(keep) => keep
                    .as_u64()
                    .filter(|keep| *keep as usize <= MAX_KEEP)
                    .ok_or_else(|| {
                        Error::Validation(format!("Truncate keeps from 0 to {MAX_KEEP} characters"))
                    })? as usize,
            };
            rules.push(Rule {
                pattern,
                items: path.contains('['),
                method,
                keep,
            });
        }
        Ok(Self(rules))
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    /// Whether a rule names the field at `path` (`["card", "number"]`) or one that holds it.
    pub fn names(&self, path: &[&str]) -> bool {
        let path: Vec<Segment> = path
            .iter()
            .map(|key| Segment::Key(key.to_lowercase()))
            .collect();
        self.find(&path).is_some()
    }
    /// The rules of another set after these: several sets mask as one.
    pub fn extend(&mut self, other: Rules) {
        self.0.extend(other.0);
    }
    /// The first rule that names `path` (its keys in lowercase).
    pub(super) fn find(&self, path: &[Segment]) -> Option<&Rule> {
        if path.is_empty() {
            return None;
        }
        let fields: Vec<Segment> = path
            .iter()
            .filter(|segment| matches!(segment, Segment::Key(_)))
            .cloned()
            .collect();
        self.0.iter().find(|rule| {
            if rule.items {
                rule.pattern.covers(path)
            } else {
                // Arrays on the way do not count, unless the field itself is an item.
                matches!(path.last(), Some(Segment::Key(_))) && rule.pattern.covers(&fields)
            }
        })
    }
}
