//! `response.compare`: what changed between two responses. The status and the error, the
//! headers by name, and the body: field by field when both are JSON (with
//! `nexo_domain::diff`), as text otherwise, and only whether they are equal when one is
//! binary. Body paths and headers the person names are left out. Also `schema.infer`.
mod schema;

pub use schema::infer_schema;

use nexo_domain::{
    Error, Result,
    diff::{self, Pattern},
};
use serde_json::{Map, Value, json};

/// Paths and headers one comparison leaves out, at most.
pub const MAX_IGNORED: usize = 100;
/// Characters of each one, at most.
const MAX_IGNORED_TEXT: usize = 300;

/// Compares `source` with `target` as `response.compare` asks.
pub fn responses(payload: &Value) -> Result<Value> {
    let ignore = texts(&payload["ignore"])?
        .iter()
        .map(|text| Pattern::parse(text))
        .collect::<Result<Vec<_>>>()?;
    let ignored_headers = texts(&payload["ignoreHeaders"])?;
    let (source, target) = (&payload["source"], &payload["target"]);
    let status = status(source, target);
    let headers = headers(source, target, &ignored_headers);
    let body = body(source, target, &ignore);
    Ok(json!({
        "same": status["same"] == true && headers.is_empty() && body["same"] == true,
        "status": status,
        "headers": headers,
        "body": body,
    }))
}

/// The texts of a list, without the empty ones, within the limits.
fn texts(list: &Value) -> Result<Vec<String>> {
    let texts: Vec<String> = list
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(String::from)
        .collect();
    if texts.len() > MAX_IGNORED {
        return Err(Error::Validation(format!(
            "A comparison leaves out {MAX_IGNORED} paths and {MAX_IGNORED} headers at most"
        )));
    }
    if texts
        .iter()
        .any(|text| text.chars().count() > MAX_IGNORED_TEXT)
    {
        return Err(Error::Validation(format!(
            "A path or header to leave out has {MAX_IGNORED_TEXT} characters at most"
        )));
    }
    Ok(texts)
}

/// The status code and the error of each side: the reason phrase does not count, since
/// HTTP/2 has none.
fn status(source: &Value, target: &Value) -> Value {
    let side = |response: &Value| {
        let mut side = json!({
            "status": response["status"].as_u64().unwrap_or(0),
            "statusText": response["statusText"].as_str().unwrap_or_default(),
        });
        if let Some(error) = response["error"].as_str().filter(|e| !e.is_empty()) {
            side["error"] = json!(error);
        }
        side
    };
    let (source, target) = (side(source), side(target));
    json!({
        "same": source["status"] == target["status"] && source["error"] == target["error"],
        "source": source,
        "target": target,
    })
}

/// Whether a header name is one of those left out: compared without case, and `*` stands
/// for any text (`X-Amzn-*`).
fn left_out(name: &str, ignored: &[String]) -> bool {
    let name = name.to_ascii_lowercase();
    ignored.iter().any(|pattern| {
        let pattern = pattern.to_ascii_lowercase();
        let mut parts = pattern.split('*');
        let first = parts.next().unwrap_or_default();
        let Some(mut rest) = name.strip_prefix(first) else {
            return false;
        };
        let parts: Vec<&str> = parts.collect();
        let Some((last, middle)) = parts.split_last() else {
            return rest.is_empty();
        };
        for part in middle {
            match rest.find(part) {
                Some(at) => rest = &rest[at + part.len()..],
                None => return false,
            }
        }
        rest.len() >= last.len() && rest.ends_with(last)
    })
}

/// The headers of a response by name without case, in the order they came, with the values
/// of a repeated one joined by commas.
fn header_map(response: &Value) -> Map<String, Value> {
    let mut names = Map::new();
    for header in response["headers"].as_array().into_iter().flatten() {
        let (Some(key), Some(value)) = (header["key"].as_str(), header["value"].as_str()) else {
            continue;
        };
        let entry = names
            .entry(key.to_ascii_lowercase())
            .or_insert_with(|| json!({"name": key, "value": ""}));
        let joined = match entry["value"].as_str() {
            Some("") | None => value.to_string(),
            Some(before) => format!("{before}, {value}"),
        };
        entry["value"] = json!(joined);
    }
    names
}

/// The headers that differ, by name: those of `source` in their order, then the new ones.
fn headers(source: &Value, target: &Value, ignored: &[String]) -> Vec<Value> {
    let (before, after) = (header_map(source), header_map(target));
    let mut names: Vec<&String> = before.keys().collect();
    names.extend(after.keys().filter(|name| !before.contains_key(*name)));
    names
        .into_iter()
        .filter_map(|name| {
            let (a, b) = (before.get(name), after.get(name));
            let shown = a.or(b)?["name"].as_str().unwrap_or(name);
            if left_out(shown, ignored) || a.map(|h| &h["value"]) == b.map(|h| &h["value"]) {
                return None;
            }
            let mut difference = json!({"name": shown});
            if let Some(a) = a {
                difference["source"] = a["value"].clone();
            }
            if let Some(b) = b {
                difference["target"] = b["value"].clone();
            }
            Some(difference)
        })
        .collect()
}

/// A body read as JSON; an empty one is text.
fn json_body(text: &str) -> Option<Value> {
    if text.trim().is_empty() {
        return None;
    }
    serde_json::from_str(text).ok()
}

fn body(source: &Value, target: &Value, ignore: &[Pattern]) -> Value {
    let text = |side: &Value| side["body"].as_str().unwrap_or_default().to_string();
    let (a, b) = (text(source), text(target));
    let cut = source["truncated"] == true || target["truncated"] == true;
    let binary = |side: &Value| side["bodyEncoding"] == "base64";
    if binary(source) || binary(target) {
        let same = binary(source) && binary(target) && a == b;
        return json!({"format": "binary", "same": same, "cut": cut});
    }
    let (Some(a_json), Some(b_json)) = (json_body(&a), json_body(&b)) else {
        return json!({"format": "text", "same": a == b, "cut": cut, "source": a, "target": b});
    };
    let (differences, complete) = diff::body_differences(&a_json, &b_json, ignore);
    let pretty = |value: &Value| {
        serde_json::to_string_pretty(&diff::canonical(value, ignore)).unwrap_or_default()
    };
    json!({
        "format": "json",
        "same": differences.is_empty(),
        "cut": cut,
        "differences": differences,
        "complete": complete,
        "source": pretty(&a_json),
        "target": pretty(&b_json),
    })
}

#[cfg(test)]
mod tests;
