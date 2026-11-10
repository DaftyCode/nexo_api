//! The outline of a definition for the explorer: paths, their operations with parameters,
//! body and responses, and the named schemas.
use super::{Spec, Version, operations, parameters, pointer};
use serde_json::{Value, json};

/// A short label for a schema: the name it refers to, or its type.
pub fn schema_label(schema: &Value) -> String {
    if let Some(reference) = schema["$ref"].as_str() {
        return reference
            .rsplit('/')
            .next()
            .unwrap_or(reference)
            .to_string();
    }
    let kind = match &schema["type"] {
        Value::String(kind) => kind.clone(),
        Value::Array(kinds) => kinds
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" | "),
        _ if schema.get("properties").is_some() => "object".into(),
        _ => String::new(),
    };
    if kind == "array" {
        let items = schema_label(&schema["items"]);
        return if items.is_empty() {
            kind
        } else {
            format!("{items}[]")
        };
    }
    kind
}

pub fn outline(spec: &Spec) -> Value {
    let version = spec.version();
    let mut paths: Vec<Value> = Vec::new();
    for operation in operations(spec) {
        let parameters: Vec<Value> = parameters(spec, &operation)
            .into_iter()
            .filter(|p| p.location != "body")
            .map(|parameter| {
                let schema = if version == Version::Swagger2 {
                    parameter.value
                } else {
                    &parameter.value["schema"]
                };
                json!({
                    "name": parameter.name,
                    "in": parameter.location,
                    "required": parameter.value["required"] == true,
                    "type": schema_label(schema),
                    "pointer": parameter.pointer,
                })
            })
            .collect();
        let body = request_body(spec, version, &operation);
        let responses_at = pointer(&operation.pointer, "responses");
        let responses: Vec<Value> = operation.value["responses"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(status, response)| {
                let (response, at) = spec.resolve(response, &pointer(&responses_at, status));
                let schema = if version == Version::Swagger2 {
                    schema_label(&response["schema"])
                } else {
                    response["content"]
                        .as_object()
                        .and_then(|content| content.values().next())
                        .map(|media| schema_label(&media["schema"]))
                        .unwrap_or_default()
                };
                json!({
                    "status": status,
                    "description": response["description"].as_str().unwrap_or(""),
                    "schema": schema,
                    "pointer": at,
                })
            })
            .collect();
        let entry = json!({
            "method": operation.method,
            "operationId": operation.value["operationId"].as_str().unwrap_or(""),
            "summary": operation.value["summary"].as_str().unwrap_or(""),
            "deprecated": operation.value["deprecated"] == true,
            "pointer": operation.pointer,
            "parameters": parameters,
            "requestBody": body,
            "responses": responses,
        });
        match paths.iter_mut().find(|p| p["path"] == operation.path) {
            Some(path) => path["operations"].as_array_mut().unwrap().push(entry),
            None => paths.push(json!({
                "path": operation.path,
                "pointer": pointer("/paths", operation.path),
                "operations": [entry],
            })),
        }
    }
    let schemas_at = if version == Version::Swagger2 {
        "/definitions"
    } else {
        "/components/schemas"
    };
    let schemas: Vec<Value> = spec
        .root
        .pointer(schemas_at)
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .map(|(name, schema)| {
            json!({
                "name": name,
                "type": schema_label(schema),
                "pointer": pointer(schemas_at, name),
            })
        })
        .collect();
    json!({
        "title": spec.root["info"]["title"].as_str().unwrap_or(""),
        "version": spec.root["info"]["version"].as_str().unwrap_or(""),
        "paths": paths,
        "schemas": schemas,
    })
}

/// The request body: OpenAPI 3 `requestBody`, or a Swagger 2 `in: body` parameter.
fn request_body(spec: &Spec, version: Version, operation: &super::Operation) -> Value {
    if version == Version::Swagger2 {
        return parameters(spec, operation)
            .into_iter()
            .find(|p| p.location == "body")
            .map(|body| {
                json!({
                    "required": body.value["required"] == true,
                    "media": operation.value["consumes"]
                        .as_array()
                        .or(spec.root["consumes"].as_array())
                        .cloned()
                        .unwrap_or_default(),
                    "schema": schema_label(&body.value["schema"]),
                    "pointer": body.pointer,
                })
            })
            .unwrap_or(Value::Null);
    }
    let Some(raw) = operation.value.get("requestBody") else {
        return Value::Null;
    };
    let (body, at) = spec.resolve(raw, &pointer(&operation.pointer, "requestBody"));
    let content = body["content"].as_object();
    json!({
        "required": body["required"] == true,
        "media": content.map(|c| c.keys().cloned().collect::<Vec<_>>()).unwrap_or_default(),
        "schema": content
            .and_then(|c| c.values().next())
            .map(|media| schema_label(&media["schema"]))
            .unwrap_or_default(),
        "pointer": at,
    })
}
