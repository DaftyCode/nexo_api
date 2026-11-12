//! Request URLs: written from their parts, with path variables filled and the query encoded
//! as Postman sends it.
use super::*;

/// Percent-encodes query text but keeps `{{variable}}` placeholders so they still resolve.
pub fn encode_query_part(value: &str) -> String {
    let mut output = String::new();
    let mut rest = value;
    while let Some(start) = rest.find("{{") {
        match rest[start..].find("}}") {
            Some(end) if !rest[start + 2..start + end].contains(['{', '}']) => {
                output.push_str(&encode_component(&rest[..start]));
                output.push_str(&rest[start..start + end + 2]);
                rest = &rest[start + end + 2..];
            }
            _ => break,
        }
    }
    output.push_str(&encode_component(rest));
    output
}
/// `encodeURIComponent` semantics.
pub fn encode_component(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            output.push(byte as char);
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

/// Request URL from a string or a `{raw, protocol, host, path, query}` object.
/// The address a request is sent to. A Postman URL object may carry path variables
/// (`/users/:id` with `variable: [{key: "id", value: "7"}]`), filled in here as Postman does.
pub fn request_url(url: &Value) -> String {
    let address = written_url(url);
    match url.get("variable") {
        Some(variables) => fill_path_variables(&address, variables),
        None => address,
    }
}

/// Replaces each `:name` path segment that has a non-empty value; the rest stay as written.
/// Only the path changes: the scheme, host, port, query and fragment are kept.
pub fn fill_path_variables(url: &str, variables: &Value) -> String {
    let values: Vec<(&str, String)> = variables
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| {
            let key = row.get("key")?.as_str().filter(|key| !key.is_empty())?;
            let value = text(row.get("value"));
            (!value.is_empty()).then_some((key, value))
        })
        .collect();
    if values.is_empty() {
        return url.to_string();
    }
    let end = url.find(['?', '#']).unwrap_or(url.len());
    let (address, rest) = url.split_at(end);
    // The path starts after `scheme://host[:port]`, or at the start without a scheme.
    let start = address
        .find("://")
        .map(|scheme| {
            address[scheme + 3..]
                .find('/')
                .map_or(address.len(), |slash| scheme + 3 + slash)
        })
        .unwrap_or(0);
    let (origin, path) = address.split_at(start);
    let path = path
        .split('/')
        .map(|segment| {
            segment
                .strip_prefix(':')
                .and_then(|name| values.iter().find(|(key, _)| *key == name))
                .map_or(segment, |(_, value)| value.as_str())
        })
        .collect::<Vec<_>>()
        .join("/");
    format!("{origin}{path}{rest}")
}

pub(super) fn written_url(url: &Value) -> String {
    match url {
        Value::String(text) => text.clone(),
        Value::Object(object) => {
            if let Some(raw) = object.get("raw").and_then(Value::as_str) {
                return raw.to_string();
            }
            let join = |value: Option<&Value>, separator: &str| match value {
                Some(Value::Array(parts)) => parts
                    .iter()
                    .map(|part| part.as_str().unwrap_or_default().to_string())
                    .collect::<Vec<_>>()
                    .join(separator),
                Some(Value::String(text)) => text.clone(),
                _ => String::new(),
            };
            let host = join(object.get("host"), ".");
            let path = join(object.get("path"), "/");
            let query: Vec<String> = object
                .get("query")
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .filter(|row| row["disabled"] != true)
                        .map(|row| {
                            format!(
                                "{}={}",
                                encode_query_part(row["key"].as_str().unwrap_or("")),
                                encode_query_part(row["value"].as_str().unwrap_or(""))
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            let protocol = object
                .get("protocol")
                .and_then(Value::as_str)
                .unwrap_or("https");
            let port = object
                .get("port")
                .and_then(|port| {
                    port.as_str()
                        .map(String::from)
                        .or_else(|| port.as_u64().map(|p| p.to_string()))
                })
                .map(|port| format!(":{port}"))
                .unwrap_or_default();
            let query = if query.is_empty() {
                String::new()
            } else {
                format!("?{}", query.join("&"))
            };
            format!("{protocol}://{host}{port}/{path}{query}")
        }
        _ => String::new(),
    }
}
