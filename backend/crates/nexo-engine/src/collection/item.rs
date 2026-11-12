//! A request as a collection item, with what it inherits from its folders.
use super::*;

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
                .map(|x| {
                    // Form-data file fields keep the names of their files.
                    if kind == "formdata" && x.get("type").and_then(Value::as_str) == Some("file") {
                        json!({"key": x["key"], "type": "file", "src": x["src"]})
                    } else {
                        json!({"key": x["key"], "value": text(x.get("value")), "type": "text"})
                    }
                })
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
