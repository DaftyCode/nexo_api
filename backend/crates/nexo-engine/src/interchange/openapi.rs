//! Importing OpenAPI 3 and Swagger 2 definitions as collections.
use super::*;

pub(super) struct OpenApi<'a> {
    pub(super) spec: &'a Value,
}
impl OpenApi<'_> {
    pub(super) fn resolve(&self, value: &Value) -> Result<Value> {
        let mut seen = HashSet::new();
        let mut current = value.clone();
        while let Some(reference) = current.get("$ref").and_then(Value::as_str) {
            let Some(pointer) = reference.strip_prefix("#/") else {
                return Err(invalid(
                    "External references must be bundled into the specification before import",
                ));
            };
            if !seen.insert(reference.to_string()) {
                return Ok(json!({}));
            }
            let mut target = self.spec;
            for key in pointer.split('/') {
                target = &target[key.replace("~1", "/").replace("~0", "~")];
            }
            if target.is_null() {
                return Err(invalid("Unresolved specification reference"));
            }
            current = target.clone();
        }
        Ok(if current.is_null() {
            json!({})
        } else {
            current
        })
    }
    pub(super) fn example(&self, schema: &Value, depth: usize) -> Result<Value> {
        let schema = self.resolve(schema)?;
        if depth > 8 {
            return Ok(Value::Null);
        }
        for key in ["example", "default"] {
            if let Some(value) = schema.get(key) {
                return Ok(value.clone());
            }
        }
        if let Some(first) = schema["enum"].as_array().and_then(|values| values.first()) {
            return Ok(first.clone());
        }
        if let Some(first) = schema["oneOf"]
            .as_array()
            .or(schema["anyOf"].as_array())
            .and_then(|v| v.first())
        {
            return self.example(first, depth + 1);
        }
        if let Some(parts) = schema["allOf"].as_array() {
            let mut merged = Map::new();
            for part in parts {
                if let Value::Object(object) = self.example(part, depth + 1)? {
                    merged.extend(object);
                }
            }
            return Ok(Value::Object(merged));
        }
        let kind = schema["type"].as_str().unwrap_or("");
        if kind == "object" || schema.get("properties").is_some() {
            let mut object = Map::new();
            for (key, item) in schema["properties"].as_object().into_iter().flatten() {
                object.insert(key.clone(), self.example(item, depth + 1)?);
            }
            return Ok(Value::Object(object));
        }
        Ok(match kind {
            "array" => json!([self.example(&schema["items"], depth + 1)?]),
            "integer" | "number" => json!(0),
            "boolean" => json!(false),
            _ if schema["format"] == "date-time" => json!("2026-01-01T00:00:00Z"),
            _ => json!("string"),
        })
    }
    pub(super) fn server_url(&self, servers: &Value) -> String {
        let Some(server) = servers.as_array().and_then(|servers| servers.first()) else {
            return match self.spec["host"].as_str() {
                Some(host) => format!(
                    "{}://{host}{}",
                    self.spec["schemes"][0].as_str().unwrap_or("https"),
                    self.spec["basePath"].as_str().unwrap_or("")
                ),
                None => "{{base_url}}".into(),
            };
        };
        let template = server["url"].as_str().unwrap_or("");
        let mut output = String::new();
        let mut rest = template;
        while let Some(open) = rest.find('{') {
            let Some(close) = rest[open..].find('}').map(|close| open + close) else {
                break;
            };
            output.push_str(&rest[..open]);
            let key = &rest[open + 1..close];
            match server["variables"][key]["default"].as_str() {
                Some(default) => output.push_str(default),
                None => output.push_str(&format!("{{{{{key}}}}}")),
            }
            rest = &rest[close + 1..];
        }
        output.push_str(rest);
        output
    }
    pub(super) fn authentication(&self, requirements: &Value) -> Result<Value> {
        let Some(name) = requirements[0].as_object().and_then(|r| r.keys().next()) else {
            return Ok(json!({"type": "noauth"}));
        };
        let schemes = if self.spec["components"]["securitySchemes"].is_object() {
            &self.spec["components"]["securitySchemes"]
        } else {
            &self.spec["securityDefinitions"]
        };
        let security = self.resolve(&schemes[name])?;
        Ok(if security["type"] == "apiKey" {
            json!({"type": "apikey", "key": security["name"], "value": "{{api_key}}", "in": security["in"]})
        } else if security["type"] == "basic" || security["scheme"] == "basic" {
            json!({"type": "basic", "username": "{{username}}", "password": "{{password}}"})
        } else {
            json!({"type": "bearer", "token": "{{access_token}}"})
        })
    }
    pub(super) fn import(&self) -> Result<Value> {
        let spec = self.spec;
        let mut folders: Vec<(String, Vec<Value>)> = Vec::new();
        for (path, source) in spec["paths"].as_object().into_iter().flatten() {
            let entry = self.resolve(source)?;
            for method in [
                "get", "post", "put", "patch", "delete", "head", "options", "trace",
            ] {
                if entry.get(method).is_none_or(Value::is_null) {
                    continue;
                }
                let operation = self.resolve(&entry[method])?;
                let (mut headers, mut query) = (Vec::new(), Vec::new());
                let servers = [&operation["servers"], &entry["servers"], &spec["servers"]]
                    .into_iter()
                    .find(|servers| !servers.is_null())
                    .unwrap_or(&Value::Null);
                let mut endpoint = self.server_url(servers).trim_end_matches('/').to_string();
                endpoint.push_str(&path_template(path));
                let mut parameters = Vec::new();
                for parameter in entry["parameters"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .chain(operation["parameters"].as_array().into_iter().flatten())
                {
                    parameters.push(self.resolve(parameter)?);
                }
                for parameter in &parameters {
                    let value = match (parameter.get("example"), parameter["examples"].get(0)) {
                        (Some(example), _) => example.clone(),
                        (None, Some(example)) => example.clone(),
                        _ => self.example(parameter.get("schema").unwrap_or(parameter), 0)?,
                    };
                    let row = json!({"key": parameter["name"], "value": js_string(&value), "enabled": true});
                    match parameter["in"].as_str() {
                        Some("query") => query.push(row),
                        Some("header") => headers.push(row),
                        _ => {}
                    }
                }
                let request_body = self.resolve(&operation["requestBody"])?;
                let content = request_body["content"]
                    .as_object()
                    .cloned()
                    .unwrap_or_default();
                let media = content
                    .keys()
                    .find(|key| key.contains("json"))
                    .or(content.keys().next())
                    .cloned();
                let body_source = match &media {
                    Some(media) => Some(content[media].clone()),
                    None => parameters.iter().find(|p| p["in"] == "body").cloned(),
                };
                let body_example = match body_source {
                    Some(source) => Some(match source.get("example") {
                        Some(example) => example.clone(),
                        None => match source["examples"]
                            .as_object()
                            .and_then(|examples| examples.values().next())
                        {
                            Some(first) => self.resolve(first)?["value"].clone(),
                            None => self.example(&source["schema"], 0)?,
                        },
                    }),
                    None => None,
                };
                if let Some(media) = &media {
                    headers.push(json!({"key": "Content-Type", "value": media, "enabled": true}));
                }
                let body = match body_example {
                    None => String::new(),
                    Some(Value::String(text)) => text,
                    Some(other) => serde_json::to_string_pretty(&other).unwrap_or_default(),
                };
                let name = operation["summary"]
                    .as_str()
                    .or(operation["operationId"].as_str())
                    .map(String::from)
                    .unwrap_or_else(|| format!("{} {path}", method.to_uppercase()));
                let security = if operation.get("security").is_some_and(|s| !s.is_null()) {
                    &operation["security"]
                } else {
                    &spec["security"]
                };
                let mut item = request_item(&json!({
                    "name": name, "method": method.to_uppercase(), "url": endpoint, "query": query,
                    "headers": headers, "body": body, "auth": self.authentication(security)?,
                }))?;
                item["request"]["description"] =
                    json!(operation["description"].as_str().unwrap_or(""));
                let folder = operation["tags"][0]
                    .as_str()
                    .unwrap_or("Requests")
                    .to_string();
                match folders.iter_mut().find(|(name, _)| *name == folder) {
                    Some((_, items)) => items.push(item),
                    None => folders.push((folder, vec![item])),
                }
            }
        }
        let name = spec["info"]["title"].as_str().unwrap_or("API import");
        Ok(json!({"kind": "collection", "name": name, "value": {
            "info": {"name": name, "schema": SCHEMA, "description": spec["info"]["description"].as_str().unwrap_or("")},
            "item": folders.into_iter().map(|(name, item)| json!({"name": name, "item": item})).collect::<Vec<_>>(),
        }}))
    }
}
/// `/pets/{id}` becomes `/pets/{{id}}`.
pub(super) fn path_template(path: &str) -> String {
    let mut output = String::new();
    let mut rest = path;
    while let Some(open) = rest.find('{') {
        match rest[open..].find('}') {
            Some(close) if close > 1 => {
                output.push_str(&rest[..open]);
                output.push_str(&format!("{{{{{}}}}}", &rest[open + 1..open + close]));
                rest = &rest[open + close + 1..];
            }
            _ => break,
        }
    }
    output.push_str(rest);
    output
}
