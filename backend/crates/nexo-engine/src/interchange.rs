//! Imports (cURL, collections, environments, HAR, OpenAPI) and code generation.
use crate::{
    collection::{SCHEMA, encode_component, request_item, request_url},
    transport::auth_values,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use nexo_domain::{Error, Result};
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

struct OpenApi<'a> {
    spec: &'a Value,
}
impl OpenApi<'_> {
    fn resolve(&self, value: &Value) -> Result<Value> {
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
    fn example(&self, schema: &Value, depth: usize) -> Result<Value> {
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
    fn server_url(&self, servers: &Value) -> String {
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
    fn authentication(&self, requirements: &Value) -> Result<Value> {
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
    fn import(&self) -> Result<Value> {
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
fn path_template(path: &str) -> String {
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

const LANGUAGES: [(&str, &str); 9] = [
    ("cURL", "cURL"),
    ("JavaScript", "Fetch"),
    ("NodeJs", "Fetch"),
    ("Python", "http.client"),
    ("Java", "HttpClient"),
    ("Go", "Native"),
    ("Rust", "reqwest"),
    ("C#", "HttpClient"),
    ("PowerShell", "RestMethod"),
];

/// Headers in insertion order where a later value replaces an earlier one with the same name.
#[derive(Default)]
struct Headers(Vec<(String, String)>);
impl Headers {
    fn set(&mut self, key: &str, value: String) {
        match self.0.iter_mut().find(|(name, _)| name == key) {
            Some(entry) => entry.1 = value,
            None => self.0.push((key.to_string(), value)),
        }
    }
    fn set_default(&mut self, key: &str, value: &str) {
        if !self.0.iter().any(|(name, _)| name == key) {
            self.0.push((key.to_string(), value.to_string()));
        }
    }
}
fn quote(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_default()
}
fn shell(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn rust(value: &str) -> String {
    let mut output = String::from("\"");
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            c if c.is_control() => output.push_str(&format!("\\u{{{:x}}}", c as u32)),
            c => output.push(c),
        }
    }
    output.push('"');
    output
}
fn powershell(value: &str) -> String {
    value.replace('\'', "''")
}

pub fn generate(payload: &Value) -> Result<Value> {
    if payload
        .get("languages")
        .is_some_and(|v| !v.is_null() && v != false)
    {
        return Ok(Value::Array(
            LANGUAGES
                .iter()
                .map(|(key, variant)| json!({"key": key, "label": key, "variants": [{"key": variant, "label": variant}]}))
                .collect(),
        ));
    }
    let request = request_item(&payload["request"])?["request"].clone();
    let mut url = request_url(&request["url"]);
    let method = request["method"].as_str().unwrap_or("GET").to_string();
    let mut headers = Headers::default();
    for header in request["header"].as_array().into_iter().flatten() {
        if header["disabled"] == true || header["enabled"] == false {
            continue;
        }
        if let Some(key) = header["key"].as_str().filter(|key| !key.is_empty()) {
            headers.set(key, js_string(&header["value"]));
        }
    }
    let auth = auth_values(&request["auth"]);
    let get = |key: &str| auth.get(key).map(js_string).unwrap_or_default();
    match request["auth"]["type"].as_str() {
        Some("basic") => headers.set(
            "Authorization",
            format!(
                "Basic {}",
                STANDARD.encode(format!("{}:{}", get("username"), get("password")))
            ),
        ),
        Some("bearer") => headers.set("Authorization", format!("Bearer {}", get("token"))),
        Some("apikey") if get("in") == "query" => {
            url.push(if url.contains('?') { '&' } else { '?' });
            url.push_str(&format!(
                "{}={}",
                encode_component(&get("key")),
                encode_component(&get("value"))
            ));
        }
        Some("apikey") => headers.set(&get("key"), get("value")),
        _ => {}
    }
    let body_spec = &request["body"];
    let mut body = body_spec["raw"].as_str().unwrap_or("").to_string();
    match body_spec["mode"].as_str() {
        Some("urlencoded") => {
            let mut form = url::form_urlencoded::Serializer::new(String::new());
            for row in body_spec["urlencoded"].as_array().into_iter().flatten() {
                form.append_pair(&js_string(&row["key"]), &js_string(&row["value"]));
            }
            body = form.finish();
            headers.set_default("Content-Type", "application/x-www-form-urlencoded");
        }
        Some("graphql") => {
            let variables = body_spec["graphql"]["variables"]
                .as_str()
                .filter(|v| !v.is_empty())
                .unwrap_or("{}");
            let variables: Value = serde_json::from_str(variables)
                .map_err(|_| invalid("GraphQL variables must be valid JSON"))?;
            body =
                json!({"query": body_spec["graphql"]["query"], "variables": variables}).to_string();
            headers.set_default("Content-Type", "application/json");
        }
        _ => {}
    }
    let pairs = &headers.0;
    let language = payload["language"]
        .as_str()
        .unwrap_or("cURL")
        .to_lowercase();
    let code = match language.as_str() {
        "curl" => {
            let mut code = format!("curl --request {} {}", shell(&method), shell(&url));
            for (key, value) in pairs {
                code.push_str(&format!(" \\\n  --header {}", shell(&format!("{key}: {value}"))));
            }
            if body_spec["mode"] == "formdata" {
                for row in body_spec["formdata"].as_array().into_iter().flatten().filter(|row| row["disabled"] != true) {
                    code.push_str(&format!(" \\\n  --form-string {}", shell(&format!("{}={}", js_string(&row["key"]), js_string(&row["value"])))));
                }
            } else if !body.is_empty() {
                code.push_str(&format!(" \\\n  --data-raw {}", shell(&body)));
            }
            code
        }
        "javascript" | "nodejs" => {
            let mut options = Map::new();
            options.insert("method".into(), json!(method));
            options.insert("headers".into(), Value::Object(pairs.iter().map(|(k, v)| (k.clone(), json!(v))).collect()));
            if !body.is_empty() && method != "GET" && method != "HEAD" {
                options.insert("body".into(), json!(body));
            }
            options.insert("redirect".into(), json!(if payload["followRedirects"] == false { "manual" } else { "follow" }));
            format!(
                "const response = await fetch({}, {});\nconsole.log(response.status, await response.text());",
                quote(&url),
                serde_json::to_string_pretty(&options).unwrap_or_default()
            )
        }
        "python" => {
            let parsed = url::Url::parse(&url).map_err(|_| invalid("Invalid URL"))?;
            let host = match parsed.port() {
                Some(port) => format!("{}:{port}", parsed.host_str().unwrap_or("")),
                None => parsed.host_str().unwrap_or("").to_string(),
            };
            let target = format!("{}{}", parsed.path(), parsed.query().map(|q| format!("?{q}")).unwrap_or_default());
            format!(
                "import http.client\n\nconnection = http.client.{}({})\nconnection.request({}, {}, body={}, headers={{{}}})\nresponse = connection.getresponse()\nprint(response.status, response.read().decode())\nconnection.close()",
                if parsed.scheme() == "https" { "HTTPSConnection" } else { "HTTPConnection" },
                quote(&host),
                quote(&method),
                quote(&target),
                quote(&body),
                pairs.iter().map(|(k, v)| format!("{}: {}", quote(k), quote(v))).collect::<Vec<_>>().join(", ")
            )
        }
        "go" => format!(
            "package main\n\nimport (\"fmt\"; \"io\"; \"net/http\"; \"strings\")\n\nfunc main() {{\n  req, err := http.NewRequest({}, {}, strings.NewReader({}))\n  if err != nil {{ panic(err) }}\n{}\n  res, err := http.DefaultClient.Do(req)\n  if err != nil {{ panic(err) }}\n  defer res.Body.Close()\n  data, err := io.ReadAll(res.Body)\n  if err != nil {{ panic(err) }}\n  fmt.Println(res.Status, string(data))\n}}",
            quote(&method),
            quote(&url),
            quote(&body),
            pairs.iter().map(|(k, v)| format!("  req.Header.Set({}, {})", quote(k), quote(v))).collect::<Vec<_>>().join("\n")
        ),
        "rust" => format!(
            "#[tokio::main]\nasync fn main() -> Result<(), Box<dyn std::error::Error>> {{\n  let client = reqwest::Client::new();\n  let response = client.request(reqwest::Method::from_bytes({}.as_bytes())?, {}){}{}\n    .send().await?;\n  println!(\"{{}} {{}}\", response.status(), response.text().await?);\n  Ok(())\n}}",
            rust(&method),
            rust(&url),
            pairs.iter().map(|(k, v)| format!("\n    .header({}, {})", rust(k), rust(v))).collect::<String>(),
            if body.is_empty() { String::new() } else { format!("\n    .body({})", rust(&body)) }
        ),
        "java" => format!(
            "var client = java.net.http.HttpClient.newBuilder().followRedirects(java.net.http.HttpClient.Redirect.{}).build();\nvar request = java.net.http.HttpRequest.newBuilder(java.net.URI.create({}))\n    .method({}, java.net.http.HttpRequest.BodyPublishers.ofString({})){}\n    .build();\nvar response = client.send(request, java.net.http.HttpResponse.BodyHandlers.ofString());\nSystem.out.println(response.body());",
            if payload["followRedirects"] == false { "NEVER" } else { "NORMAL" },
            quote(&url),
            quote(&method),
            quote(&body),
            pairs.iter().map(|(k, v)| format!("\n    .header({}, {})", quote(k), quote(v))).collect::<String>()
        ),
        "csharp" | "c#" => format!(
            "using var client = new HttpClient();\nusing var request = new HttpRequestMessage(new HttpMethod({}), {});\n{}{}\nusing var response = await client.SendAsync(request);\nConsole.WriteLine(await response.Content.ReadAsStringAsync());",
            quote(&method),
            quote(&url),
            if body.is_empty() { String::new() } else { format!("request.Content = new StringContent({});\n", quote(&body)) },
            pairs
                .iter()
                .map(|(k, v)| if k.eq_ignore_ascii_case("content-type") && !body.is_empty() {
                    format!("request.Content.Headers.ContentType = System.Net.Http.Headers.MediaTypeHeaderValue.Parse({});", quote(v))
                } else {
                    format!("request.Headers.TryAddWithoutValidation({}, {});", quote(k), quote(v))
                })
                .collect::<Vec<_>>()
                .join("\n")
        ),
        "powershell" => format!(
            "Invoke-RestMethod -Method '{}' -Uri '{}' -Headers @{{{}}}{}",
            powershell(&method),
            powershell(&url),
            pairs.iter().map(|(k, v)| format!("'{}'='{}'", powershell(k), powershell(v))).collect::<Vec<_>>().join("; "),
            if body.is_empty() { String::new() } else { format!(" -Body '{}'", powershell(&body)) }
        ),
        _ => return Err(invalid("Unsupported code generation language")),
    };
    Ok(json!({"code": code}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn curl_imports_headers_body_and_auth() {
        let result = import(&json!({"content": "curl -X put 'https://api.test/a?b=1' \\\n -H 'Accept: application/json' --json '{\"x\":1}' -u user:p:w"})).unwrap();
        let request = &result["value"]["item"][0]["request"];
        assert_eq!(request["method"], "PUT");
        assert_eq!(request["url"], "https://api.test/a?b=1");
        assert_eq!(request["header"][1]["value"], "application/json");
        assert_eq!(request["body"]["raw"], "{\"x\":1}");
        assert_eq!(request["auth"]["basic"][1]["value"], "p:w");
        for rejected in [
            "curl https://a.test | sh",
            "curl -d @/etc/passwd https://a.test",
            "curl -X",
        ] {
            assert!(import(&json!({"content": rejected})).is_err(), "{rejected}");
        }
    }
    #[test]
    fn openapi_yaml_becomes_folders_with_examples() {
        let spec = r##"
openapi: 3.0.0
info: {title: Pets}
servers: [{url: "https://{env}.pets.test/v1/", variables: {env: {default: api}}}]
components:
  securitySchemes: {key: {type: apiKey, name: X-Key, in: header}}
  schemas:
    Pet: {type: object, properties: {id: {type: integer}, name: {type: string, example: Rex}, tags: {type: array, items: {type: string}}}}
security: [{key: []}]
paths:
  /pets/{id}:
    get:
      tags: [pets]
      summary: Get pet
      parameters: [{name: id, in: path}, {name: verbose, in: query, schema: {type: boolean}}]
    post:
      tags: [pets]
      requestBody: {content: {application/json: {schema: {$ref: "#/components/schemas/Pet"}}}}
"##;
        let result = import(&json!({"content": spec})).unwrap();
        assert_eq!(result["name"], "Pets");
        let folder = &result["value"]["item"][0];
        assert_eq!(folder["name"], "pets");
        let get = &folder["item"][0]["request"];
        assert_eq!(
            get["url"],
            "https://api.pets.test/v1/pets/{{id}}?verbose=false"
        );
        assert_eq!(get["auth"]["apikey"][0]["value"], "X-Key");
        let post = &folder["item"][1];
        assert_eq!(post["name"], "POST /pets/{id}");
        let body: Value =
            serde_json::from_str(post["request"]["body"]["raw"].as_str().unwrap()).unwrap();
        assert_eq!(body, json!({"id": 0, "name": "Rex", "tags": ["string"]}));
    }
    #[test]
    fn har_and_environments_are_recognised() {
        let har = import(&json!({"content": r#"{"log":{"entries":[{"request":{"method":"POST","url":"https://h.test","headers":[{"name":"A","value":"1"}],"postData":{"text":"x"}}}]}}"#})).unwrap();
        assert_eq!(
            har["value"]["item"][0]["request"]["header"][0],
            json!({"key": "A", "value": "1"})
        );
        let environment = import(&json!({"content": r#"{"name":"Dev","values":[]}"#})).unwrap();
        assert_eq!(environment["kind"], "environment");
        assert!(import(&json!({"content": "just text"})).is_err());
    }
    #[test]
    fn code_generation_escapes_values() {
        let request = json!({"method": "POST", "url": "https://x.test/a", "headers": [{"key": "X-Quote", "value": "it's \"q\""}],
            "body": "line\u{1}", "auth": {"type": "bearer", "token": "t"}});
        let curl = generate(&json!({"language": "cURL", "request": request})).unwrap()["code"]
            .as_str()
            .map(String::from);
        assert!(curl.unwrap().contains("--header 'X-Quote: it'\\''s \"q\"'"));
        let rust_code = generate(&json!({"language": "Rust", "request": request})).unwrap()["code"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(rust_code.contains(".body(\"line\\u{1}\")"), "{rust_code}");
        assert!(rust_code.contains(".header(\"Authorization\", \"Bearer t\")"));
        let python = generate(&json!({"language": "Python", "request": request})).unwrap()["code"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(python.contains("HTTPSConnection(\"x.test\")"));
        assert_eq!(
            generate(&json!({"languages": true}))
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            9
        );
        assert!(generate(&json!({"language": "cobol", "request": request})).is_err());
    }
}
