//! Field by field differences between two JSON documents. Collections of MongoDB compare
//! canonical Extended JSON, with arrays and BSON values whole; responses compare their JSON
//! bodies item by item, leaving out the paths that some patterns name.
mod path;

pub use path::{Pattern, Segment, json_path};

use serde::Serialize;
use serde_json::{Map, Value};

/// Differences reported for one document at most.
pub const MAX_FIELD_DIFFERENCES: usize = 100;
/// Differences reported for the bodies of two responses at most.
pub const MAX_BODY_DIFFERENCES: usize = 1000;

/// A field whose value differs, with each side's value; a missing side is absent.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FieldDifference {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<Value>,
}

/// How two documents are walked.
struct Rules<'a> {
    /// Arrays compared item by item; otherwise whole.
    items: bool,
    /// Extended JSON wrappers (`{$oid: …}`, `{$date: …}`) compared whole, as the values
    /// they are.
    wrappers: bool,
    /// Paths left out, with what is under them.
    skip: &'a dyn Fn(&[Segment]) -> bool,
    /// Differences found at most.
    limit: usize,
}

/// A difference found: where, and each side's value.
type Found = (Vec<Segment>, Option<Value>, Option<Value>);

/// Whether an object is a BSON value written as Extended JSON (`{$oid: …}`, `{$date: …}`).
fn wrapper(fields: &Map<String, Value>) -> bool {
    fields.keys().next().is_some_and(|key| key.starts_with('$'))
}

fn walk(
    path: &mut Vec<Segment>,
    source: Option<&Value>,
    target: Option<&Value>,
    rules: &Rules,
    found: &mut Vec<Found>,
) {
    if found.len() >= rules.limit || (!path.is_empty() && (rules.skip)(path)) {
        return;
    }
    match (source, target) {
        (Some(Value::Object(a)), Some(Value::Object(b)))
            if !(rules.wrappers && (wrapper(a) || wrapper(b))) =>
        {
            let mut keys: Vec<&String> = a.keys().collect();
            keys.extend(b.keys().filter(|key| !a.contains_key(*key)));
            for key in keys {
                path.push(Segment::Key(key.clone()));
                walk(path, a.get(key), b.get(key), rules, found);
                path.pop();
            }
        }
        (Some(Value::Array(a)), Some(Value::Array(b))) if rules.items => {
            for index in 0..a.len().max(b.len()) {
                path.push(Segment::Index(index));
                walk(path, a.get(index), b.get(index), rules, found);
                path.pop();
            }
        }
        (a, b) if a == b => {}
        (a, b) => found.push((path.clone(), a.cloned(), b.cloned())),
    }
}

fn find(source: &Value, target: &Value, rules: &Rules) -> Vec<Found> {
    let mut found = Vec::new();
    walk(
        &mut Vec::new(),
        Some(source),
        Some(target),
        rules,
        &mut found,
    );
    found
}

/// A path of a MongoDB document: its fields joined by dots.
fn dotted(path: &[Segment]) -> String {
    let parts: Vec<String> = path
        .iter()
        .map(|segment| match segment {
            Segment::Key(key) => key.clone(),
            Segment::Index(index) => index.to_string(),
        })
        .collect();
    parts.join(".")
}

fn ignored(path: &str, ignore: &[String]) -> bool {
    ignore.iter().any(|field| {
        path == field
            || path
                .strip_prefix(field.as_str())
                .is_some_and(|rest| rest.starts_with('.'))
    })
}

/// The differences of two MongoDB documents, leaving out the `ignore` paths and what is
/// under them. Arrays and BSON values are compared whole.
pub fn differences(source: &Value, target: &Value, ignore: &[String]) -> Vec<FieldDifference> {
    let skip = |path: &[Segment]| ignored(&dotted(path), ignore);
    let rules = Rules {
        items: false,
        wrappers: true,
        skip: &skip,
        limit: MAX_FIELD_DIFFERENCES,
    };
    find(source, target, &rules)
        .into_iter()
        .map(|(path, source, target)| FieldDifference {
            path: dotted(&path),
            source,
            target,
        })
        .collect()
}

/// The differences of two JSON bodies, item by item, with JSONPath paths, leaving out what
/// `ignore` names; and whether they are all of them (there are at most
/// [`MAX_BODY_DIFFERENCES`]).
pub fn body_differences(
    source: &Value,
    target: &Value,
    ignore: &[Pattern],
) -> (Vec<FieldDifference>, bool) {
    let skip = |path: &[Segment]| ignore.iter().any(|pattern| pattern.covers(path));
    let rules = Rules {
        items: true,
        wrappers: false,
        skip: &skip,
        limit: MAX_BODY_DIFFERENCES + 1,
    };
    let mut found = find(source, target, &rules);
    let complete = found.len() <= MAX_BODY_DIFFERENCES;
    found.truncate(MAX_BODY_DIFFERENCES);
    let differences = found
        .into_iter()
        .map(|(path, source, target)| FieldDifference {
            path: json_path(&path),
            source,
            target,
        })
        .collect();
    (differences, complete)
}

/// A JSON body as two of them are shown side by side: its fields in alphabetical order, so
/// their order does not count, and without what `ignore` names.
pub fn canonical(value: &Value, ignore: &[Pattern]) -> Value {
    fn walk(value: &Value, path: &mut Vec<Segment>, ignore: &[Pattern]) -> Value {
        let mut kept = |segment: Segment, value: &Value| {
            path.push(segment);
            let kept = (!ignore.iter().any(|pattern| pattern.covers(path)))
                .then(|| walk(value, path, ignore));
            path.pop();
            kept
        };
        match value {
            Value::Object(fields) => {
                let mut keys: Vec<&String> = fields.keys().collect();
                keys.sort();
                let mut sorted = Map::new();
                for key in keys {
                    if let Some(inner) = kept(Segment::Key(key.clone()), &fields[key]) {
                        sorted.insert(key.clone(), inner);
                    }
                }
                Value::Object(sorted)
            }
            Value::Array(items) => Value::Array(
                items
                    .iter()
                    .enumerate()
                    .filter_map(|(index, item)| kept(Segment::Index(index), item))
                    .collect(),
            ),
            other => other.clone(),
        }
    }
    walk(value, &mut Vec::new(), ignore)
}

/// The value at a dotted path of a document.
pub fn value_at<'a>(document: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.')
        .try_fold(document, |value, part| value.as_object()?.get(part))
}

#[cfg(test)]
mod tests;
