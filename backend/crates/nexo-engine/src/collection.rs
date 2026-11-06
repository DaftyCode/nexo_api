//! Portable collection format (Postman Collection v2.1 compatible) handled by the engine.
use nexo_domain::{Error, Result};
use serde_json::{Map, Value, json};

pub const SCHEMA: &str = "urn:nexo:collection:1";

/// HTTP method token (RFC 9110); rejects values that could alter generated code.
pub fn http_method(value: &str) -> Result<String> {
    let method = value.trim().to_uppercase();
    let method = if method.is_empty() {
        "GET".to_string()
    } else {
        method
    };
    let valid = method.len() <= 32
        && method
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_uppercase())
        && method
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "!#$%&'*+.^_`|~-".contains(c));
    if valid {
        Ok(method)
    } else {
        Err(Error::Validation(format!("Invalid HTTP method: {value}")))
    }
}

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

fn written_url(url: &Value) -> String {
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

fn rows(value: &Value, enabled_key: bool) -> Vec<&Map<String, Value>> {
    value
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(Value::as_object)
                .filter(|row| {
                    row.get("key")
                        .and_then(Value::as_str)
                        .is_some_and(|k| !k.is_empty())
                        && if enabled_key {
                            row.get("enabled") != Some(&Value::Bool(false))
                        } else {
                            true
                        }
                })
                .collect()
        })
        .unwrap_or_default()
}
fn text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

/// Converts the request shapes accepted from the interface, MCP and the CLI into a
/// collection item. Items already in the collection format pass through.
pub fn request_item(input: &Value) -> Result<Value> {
    if input.get("request").is_some_and(Value::is_object) && input.get("method").is_none() {
        return Ok(input.clone());
    }
    let headers: Vec<Value> = rows(input.get("headers").unwrap_or(&Value::Null), true)
        .into_iter()
        .map(|h| json!({"key": h["key"], "value": text(h.get("value")), "disabled": false}))
        .collect();
    let mut url = text(input.get("url"));
    let query: Vec<String> = rows(input.get("query").unwrap_or(&Value::Null), true)
        .into_iter()
        .map(|q| {
            format!(
                "{}={}",
                encode_query_part(&text(q.get("key"))),
                encode_query_part(&text(q.get("value")))
            )
        })
        .collect();
    if !query.is_empty() {
        url.push(if url.contains('?') { '&' } else { '?' });
        url.push_str(&query.join("&"));
    }
    let auth_input = input
        .get("auth")
        .cloned()
        .unwrap_or(json!({"type": "noauth"}));
    let auth_type = auth_input["type"].as_str().unwrap_or("noauth").to_string();
    let field = |key: &str, fallback: &str| -> Value {
        Value::String(
            auth_input
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or(fallback)
                .to_string(),
        )
    };
    // Already in the collection format (`{type, <type>: [...]}`): kept as it is, with every
    // option of the type.
    let stored = auth_input
        .get(&auth_type)
        .is_some_and(|values| values.is_array() || values.is_object());
    let auth = match auth_type.as_str() {
        "inherit" => Value::Null,
        _ if stored => auth_input.clone(),
        "bearer" => {
            json!({"type": "bearer", "bearer": [{"key": "token", "value": field("token", ""), "type": "string"}]})
        }
        "basic" => json!({"type": "basic", "basic": [
            {"key": "username", "value": field("username", ""), "type": "string"},
            {"key": "password", "value": field("password", ""), "type": "string"}]}),
        "apikey" => json!({"type": "apikey", "apikey": [
            {"key": "key", "value": field("key", "X-API-Key")},
            {"key": "value", "value": field("value", "")},
            {"key": "in", "value": field("in", "header")}]}),
        _ if auth_input.get("values").is_some_and(Value::is_object) => {
            let mut values = auth_input["values"]
                .as_object()
                .cloned()
                .unwrap_or_default();
            values.insert(
                "username".into(),
                auth_input.get("username").cloned().unwrap_or(Value::Null),
            );
            values.insert(
                "password".into(),
                auth_input.get("password").cloned().unwrap_or(Value::Null),
            );
            if let Some(parameters) = auth_input
                .get("parameters")
                .and_then(Value::as_str)
                .filter(|p| !p.trim().is_empty())
            {
                let parsed: Value = serde_json::from_str(parameters).map_err(|error| {
                    Error::Validation(format!(
                        "Authorization parameters must be valid JSON: {error}"
                    ))
                })?;
                if let Some(object) = parsed.as_object() {
                    values.extend(object.clone());
                }
            }
            json!({
                "type": auth_type,
                auth_type.clone(): values.into_iter().map(|(key, value)| json!({"key": key, "value": value, "type": "string"})).collect::<Vec<_>>()
            })
        }
        _ => auth_input.clone(),
    };
    let form = |kind: &str| -> Value {
        json!({
            "mode": kind,
            kind: rows(input.get("form").unwrap_or(&Value::Null), true)
                .into_iter()
                .map(|x| json!({"key": x["key"], "value": text(x.get("value")), "type": "text"}))
                .collect::<Vec<_>>()
        })
    };
    let body = if input["protocol"] == "graphql" {
        json!({"mode": "graphql", "graphql": {
            "query": text(input.get("body")),
            "variables": input.get("graphqlVariables").and_then(Value::as_str).unwrap_or("{}")
        }})
    } else {
        match input.get("bodyMode").and_then(Value::as_str) {
            Some("urlencoded") => form("urlencoded"),
            Some("formdata") => form("formdata"),
            _ => match input.get("body") {
                Some(Value::Object(body)) if body.contains_key("mode") => {
                    Value::Object(body.clone())
                }
                body => json!({"mode": "raw", "raw": text(body), "options": {"raw": {
                    "language": input.get("bodyLanguage").and_then(Value::as_str).unwrap_or("json")
                }}}),
            },
        }
    };
    let mut events = Vec::new();
    for (listen, key) in [("prerequest", "prerequest"), ("test", "tests")] {
        if let Some(source) = input
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            events.push(json!({"listen": listen, "script": {"type": "text/javascript", "exec": source.split('\n').collect::<Vec<_>>()}}));
        }
    }
    let mut request = json!({
        "method": http_method(input.get("method").and_then(Value::as_str).unwrap_or("GET"))?,
        "url": url,
        "header": headers,
        "body": body,
    });
    if !auth.is_null() {
        request["auth"] = auth;
    }
    let mut item = json!({
        "id": input.get("id").cloned().unwrap_or_else(|| Value::String(uuid::Uuid::new_v4().to_string())),
        "name": input.get("name").and_then(Value::as_str).unwrap_or("Untitled request"),
        "request": request,
        "event": events,
    });
    if let Some(transport) = input
        .get("transport")
        .and_then(Value::as_str)
        .filter(|t| !t.trim().is_empty() && *t != "{}")
    {
        item["nexoTransport"] = Value::String(transport.to_string());
    }
    Ok(item)
}

fn inheritable(ancestor: &Value) -> Map<String, Value> {
    let mut output = Map::new();
    for key in ["variable", "event"] {
        if let Some(value) = ancestor.get(key).filter(|v| v.is_array()) {
            output.insert(key.into(), value.clone());
        }
    }
    if let Some(auth) = ancestor.get("auth").filter(|v| v.is_object()) {
        output.insert("auth".into(), auth.clone());
    }
    output
}

/// The collection to execute. A single request keeps what it inherits from the collection
/// and folders above it (`context.ancestors`, root first).
pub fn as_collection(payload: &Value) -> Result<Value> {
    if payload["collection"]["item"].is_array() {
        return Ok(payload["collection"].clone());
    }
    let item = match payload.get("item").filter(|item| item.is_object()) {
        Some(item) => item.clone(),
        None => request_item(payload.get("request").unwrap_or(&Value::Null))?,
    };
    let ancestors: Vec<Value> = payload["context"]["ancestors"]
        .as_array()
        .map(|list| list.iter().take(32).cloned().collect())
        .unwrap_or_default();
    let mut nested = item;
    for folder in ancestors.iter().skip(1).rev() {
        let mut group = inheritable(folder);
        group.insert(
            "name".into(),
            json!(folder["name"].as_str().unwrap_or("Folder")),
        );
        group.insert("item".into(), json!([nested]));
        nested = Value::Object(group);
    }
    let mut root = ancestors.first().map(inheritable).unwrap_or_default();
    let name = payload["request"]["name"]
        .as_str()
        .or_else(|| payload["item"]["name"].as_str())
        .unwrap_or("Request");
    root.insert("info".into(), json!({"name": name, "schema": SCHEMA}));
    root.insert("item".into(), json!([nested]));
    Ok(Value::Object(root))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn methods_and_query_encoding() {
        assert_eq!(http_method("post").unwrap(), "POST");
        assert!(http_method("GET; rm -rf").is_err());
        assert_eq!(encode_query_part("{{tenant}}"), "{{tenant}}");
        assert_eq!(encode_query_part("a b&{{x}}"), "a%20b%26{{x}}");
        assert_eq!(encode_component("é"), "%C3%A9");
    }
    #[test]
    fn converts_simple_requests() {
        let item = request_item(&json!({
            "url": "https://x.test", "method": "post",
            "headers": [{"key": "A", "value": "1", "enabled": true}, {"key": "B", "value": "2", "enabled": false}],
            "query": [{"key": "q", "value": "{{v}}", "enabled": true}],
            "auth": {"type": "bearer", "token": "{{token}}"},
            "body": "{}", "tests": "pm.test()"
        }))
        .unwrap();
        assert_eq!(item["request"]["url"], "https://x.test?q={{v}}");
        assert_eq!(item["request"]["method"], "POST");
        assert_eq!(item["request"]["header"].as_array().unwrap().len(), 1);
        assert_eq!(item["request"]["auth"]["bearer"][0]["value"], "{{token}}");
        assert_eq!(item["event"][0]["listen"], "test");
        let inherit = request_item(&json!({"url": "x", "auth": {"type": "inherit"}})).unwrap();
        assert!(inherit["request"].get("auth").is_none());
    }
    #[test]
    fn nests_a_request_inside_its_ancestors() {
        let collection = as_collection(&json!({
            "request": {"name": "Leaf", "url": "http://x"},
            "context": {"ancestors": [{"name": "Root", "variable": [{"key": "a", "value": "1"}]}, {"name": "Folder"}]}
        }))
        .unwrap();
        assert_eq!(collection["variable"][0]["key"], "a");
        assert_eq!(collection["item"][0]["name"], "Folder");
        assert_eq!(collection["item"][0]["item"][0]["name"], "Leaf");
    }
    #[test]
    fn fills_path_variables_like_postman() {
        let url = json!({
            "raw": "http://localhost:8080/v1/polizas/:poliza/siniestros/:empty?ramo=:poliza#:poliza",
            "variable": [{"key": "poliza", "value": "6458273"}, {"key": "empty", "value": ""}]
        });
        // The port and the query keep their colons; a variable without a value stays.
        assert_eq!(
            request_url(&url),
            "http://localhost:8080/v1/polizas/6458273/siniestros/:empty?ramo=:poliza#:poliza"
        );
        let built = json!({
            "protocol": "https", "host": ["api", "test"], "path": ["users", ":id"],
            "variable": [{"key": "id", "value": "{{user}}"}]
        });
        assert_eq!(request_url(&built), "https://api.test/users/{{user}}");
        assert_eq!(
            fill_path_variables("/a/:id", &json!([{"key": "id", "value": 7}])),
            "/a/7"
        );
        assert_eq!(request_url(&json!("http://x/:id")), "http://x/:id");
    }
    #[test]
    fn builds_urls_from_objects() {
        assert_eq!(
            request_url(
                &json!({"protocol": "http", "host": ["api", "test"], "port": "8080", "path": ["v1", "users"], "query": [{"key": "a", "value": "b c"}]})
            ),
            "http://api.test:8080/v1/users?a=b%20c"
        );
    }
}
