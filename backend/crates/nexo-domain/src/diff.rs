//! Field by field differences between two JSON documents (canonical Extended JSON for
//! MongoDB): embedded documents are compared field by field, arrays and BSON values whole.
//! Shared by the comparison of collections and, later, of responses.
use serde::Serialize;
use serde_json::{Map, Value};

/// Differences reported for one document at most.
pub const MAX_FIELD_DIFFERENCES: usize = 100;

/// A field whose value differs, with each side's value; a missing side is absent.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FieldDifference {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<Value>,
}

/// Whether an object is a BSON value written as Extended JSON (`{$oid: …}`, `{$date: …}`).
fn wrapper(fields: &Map<String, Value>) -> bool {
    fields.keys().next().is_some_and(|key| key.starts_with('$'))
}

fn ignored(path: &str, ignore: &[String]) -> bool {
    ignore.iter().any(|field| {
        path == field
            || path
                .strip_prefix(field.as_str())
                .is_some_and(|rest| rest.starts_with('.'))
    })
}

/// The differences of two documents, leaving out the `ignore` paths and what is under them.
pub fn differences(source: &Value, target: &Value, ignore: &[String]) -> Vec<FieldDifference> {
    let mut found = Vec::new();
    walk("", Some(source), Some(target), ignore, &mut found);
    found
}

fn walk(
    path: &str,
    source: Option<&Value>,
    target: Option<&Value>,
    ignore: &[String],
    found: &mut Vec<FieldDifference>,
) {
    if found.len() >= MAX_FIELD_DIFFERENCES || (!path.is_empty() && ignored(path, ignore)) {
        return;
    }
    match (source, target) {
        (Some(Value::Object(a)), Some(Value::Object(b))) if !wrapper(a) && !wrapper(b) => {
            let mut keys: Vec<&String> = a.keys().collect();
            keys.extend(b.keys().filter(|key| !a.contains_key(*key)));
            for key in keys {
                let inner = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                };
                walk(&inner, a.get(key), b.get(key), ignore, found);
            }
        }
        (a, b) if a == b => {}
        (a, b) => found.push(FieldDifference {
            path: path.to_string(),
            source: a.cloned(),
            target: b.cloned(),
        }),
    }
}

/// The value at a dotted path of a document.
pub fn value_at<'a>(document: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.')
        .try_fold(document, |value, part| value.as_object()?.get(part))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn finds_the_fields_that_differ_and_leaves_out_the_ignored_ones() {
        let source = json!({
            "_id": 1, "name": "Ana", "at": {"$date": {"$numberLong": "1"}},
            "address": {"city": "Lugo", "zip": "27001"}, "tags": ["a", "b"],
            "updatedAt": {"$date": {"$numberLong": "5"}}, "only": true,
        });
        let target = json!({
            "_id": 1, "name": "Ana", "at": {"$date": {"$numberLong": "2"}},
            "address": {"city": "Vigo", "zip": "27001"}, "tags": ["a"],
            "updatedAt": {"$date": {"$numberLong": "9"}}, "extra": 3,
        });
        let found = differences(&source, &target, &["updatedAt".into()]);
        let paths: Vec<&str> = found.iter().map(|d| d.path.as_str()).collect();
        assert_eq!(paths, ["at", "address.city", "tags", "only", "extra"]);
        assert_eq!(
            found[3],
            FieldDifference {
                path: "only".into(),
                source: Some(json!(true)),
                target: None
            }
        );
        assert_eq!(found[4].source, None);
        assert!(differences(&source, &source, &[]).is_empty());
        // A whole embedded document ignored, and a field that only looks like it.
        let ignore = ["address".to_string()];
        assert!(
            !differences(
                &json!({"address": 1, "addressee": 1}),
                &json!({"address": 2, "addressee": 1}),
                &ignore
            )
            .iter()
            .any(|d| d.path.starts_with("address"))
        );
        assert_eq!(
            differences(&json!({"addressee": 1}), &json!({"addressee": 2}), &ignore)[0].path,
            "addressee"
        );
    }

    #[test]
    fn reads_values_at_dotted_paths() {
        let document = json!({"customer": {"address": {"city": "Lugo"}}, "n": 1});
        assert_eq!(
            value_at(&document, "customer.address.city"),
            Some(&json!("Lugo"))
        );
        assert_eq!(value_at(&document, "n"), Some(&json!(1)));
        assert_eq!(value_at(&document, "customer.zip"), None);
        assert_eq!(value_at(&document, "n.x"), None);
    }
}
