//! Imports (cURL, collections, environments, HAR, OpenAPI) and code generation.

mod codegen;
mod openapi;

use crate::{
    collection::{SCHEMA, encode_component, request_item, request_url},
    transport::auth_values,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
pub use codegen::generate;
use nexo_domain::{Error, Result};
use openapi::OpenApi;
use serde_json::{Map, Value, json};
use std::collections::HashSet;

fn invalid(message: &str) -> Error {
    Error::Validation(message.into())
}
/// `String(value)` as JavaScript writes it, for the scalars found in specifications.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
        other => other.to_string(),
    }
}

pub fn import(payload: &Value) -> Result<Value> {
    let text = payload["content"].as_str().unwrap_or_default();
    if text.trim_start().starts_with("curl ") {
        return import_curl(text.trim());
    }
    let document: Value = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(_) => serde_saphyr::from_str::<Value>(text)
            .map_err(|error| Error::Validation(format!("Unsupported import format: {error}")))?,
    };
    if document.get("info").is_some_and(|info| !info.is_null()) && document["item"].is_array() {
        return Ok(
            json!({"kind": "collection", "value": document, "name": document["info"]["name"]}),
        );
    }
    if document["values"].is_array() {
        let name = document
            .get("name")
            .cloned()
            .unwrap_or(json!("Imported environment"));
        return Ok(json!({"kind": "environment", "name": name, "value": document}));
    }
    if let Some(entries) = document["log"]["entries"].as_array() {
        let items: Vec<Value> = entries
            .iter()
            .map(|entry| {
                let request = &entry["request"];
                let headers: Vec<Value> = request["headers"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|header| json!({"key": header["name"], "value": header["value"]}))
                    .collect();
                let mut converted = json!({"method": request["method"], "url": request["url"], "header": headers});
                if request["postData"].is_object() {
                    converted["body"] = json!({"mode": "raw", "raw": request["postData"]["text"].as_str().unwrap_or("")});
                }
                json!({"name": request["url"], "request": converted})
            })
            .collect();
        return Ok(json!({"kind": "collection", "name": "HAR import",
            "value": {"info": {"name": "HAR import", "schema": SCHEMA}, "item": items}}));
    }
    if document.get("openapi").is_some_and(|v| !v.is_null()) || document["swagger"] == "2.0" {
        return OpenApi { spec: &document }.import();
    }
    Err(invalid("Unsupported import format"))
}

fn import_curl(text: &str) -> Result<Value> {
    let joined = text.replace("\\\r\n", " ").replace("\\\n", " ");
    let args = shell_words::split(&joined).map_err(|_| invalid("Invalid cURL command"))?;
    if args.iter().any(|arg| {
        matches!(
            arg.as_str(),
            "|" | "||" | "&&" | ";" | "&" | ">" | ">>" | "<" | "(" | ")"
        )
    }) {
        return Err(invalid("Shell operators are not accepted in cURL imports"));
    }
    let (mut method, mut url, mut body) = ("GET".to_string(), String::new(), String::new());
    let mut headers = Vec::new();
    let mut auth = json!({"type": "noauth"});
    let mut index = 1;
    let next = |index: usize| {
        args.get(index)
            .cloned()
            .ok_or_else(|| invalid("Missing cURL option value"))
    };
    while index < args.len() {
        let arg = args[index].as_str();
        match arg {
            "-X" | "--request" => {
                index += 1;
                method = next(index)?.to_uppercase();
            }
            "-H" | "--header" => {
                index += 1;
                let value = next(index)?;
                let split = value
                    .find(':')
                    .filter(|&split| split > 0)
                    .ok_or_else(|| invalid("Invalid cURL header"))?;
                headers.push(json!({"key": &value[..split], "value": value[split + 1..].trim()}));
            }
            "-d" | "--data" | "--data-raw" | "--data-binary" | "--data-urlencode" | "--json" => {
                index += 1;
                body = next(index)?;
                if body.starts_with('@') {
                    return Err(invalid(
                        "Import the file contents explicitly; cURL file paths are not read",
                    ));
                }
                if method == "GET" {
                    method = "POST".into();
                }
                if arg == "--json" {
                    headers.push(json!({"key": "Content-Type", "value": "application/json"}));
                }
            }
            "-u" | "--user" => {
                index += 1;
                let value = next(index)?;
                let (username, password) = value.split_once(':').unwrap_or((&value, ""));
                auth = json!({"type": "basic", "username": username, "password": password});
            }
            "--url" => {
                index += 1;
                url = next(index)?;
            }
            "-I" | "--head" => method = "HEAD".into(),
            _ if arg.starts_with("http://") || arg.starts_with("https://") => url = arg.to_string(),
            _ => {}
        }
        index += 1;
    }
    if url.is_empty() {
        return Err(invalid("No HTTP URL found in cURL command"));
    }
    let item = request_item(
        &json!({"name": url, "method": method, "url": url, "headers": headers, "body": body, "auth": auth}),
    )?;
    Ok(json!({"kind": "collection", "name": "cURL import",
        "value": {"info": {"name": "cURL import", "schema": SCHEMA}, "item": [item]}}))
}

#[cfg(test)]
mod tests;
