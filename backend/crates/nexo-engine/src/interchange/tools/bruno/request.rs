//! A `.bru` request, folder or collection file as the JSON of Bruno's exports.
use super::lang::{Block, Pair, blocks, object, rows};
use serde_json::{Map, Value, json};

const METHODS: [&str; 9] = [
    "get", "post", "put", "delete", "patch", "options", "head", "connect", "trace",
];

/// `snake_case` as `camelCase`, as Bruno names the OAuth 2.0 settings in its JSON.
fn camel(key: &str) -> String {
    let mut output = String::new();
    let mut upper = false;
    for c in key.chars() {
        if c == '_' {
            upper = true;
        } else if upper {
            output.extend(c.to_uppercase());
            upper = false;
        } else {
            output.push(c);
        }
    }
    output
}

fn flag(value: &Value) -> Value {
    match value.as_str() {
        Some("true") => json!(true),
        Some("false") => json!(false),
        _ => value.clone(),
    }
}

/// The settings of an `auth:<mode>` block under the name Bruno's JSON gives them.
fn auth(auth: &mut Value, mode: &str, pairs: &[Pair]) {
    let settings = object(pairs);
    match mode {
        "oauth2" => {
            for (key, value) in settings {
                let key = camel(&key);
                let value = match key.as_str() {
                    "pkce" | "autoFetchToken" | "autoRefreshToken" => flag(&value),
                    _ => value,
                };
                auth["oauth2"][key] = value;
            }
        }
        "oauth1" => {
            let names = [
                ("consumer_key", "consumerKey"),
                ("consumer_secret", "consumerSecret"),
                ("access_token", "accessToken"),
                ("token_secret", "accessTokenSecret"),
                ("callback_url", "callbackUrl"),
                ("verifier", "verifier"),
                ("signature_method", "signatureMethod"),
                ("timestamp", "timestamp"),
                ("nonce", "nonce"),
                ("version", "version"),
                ("realm", "realm"),
                ("placement", "placement"),
            ];
            for (from, to) in names {
                if let Some(value) = settings.get(from) {
                    auth["oauth1"][to] = value.clone();
                }
            }
            let key = settings
                .get("private_key")
                .and_then(Value::as_str)
                .unwrap_or("");
            let file = key.strip_prefix("@file(").and_then(|k| k.strip_suffix(')'));
            auth["oauth1"]["privateKey"] = json!(file.unwrap_or(key));
            auth["oauth1"]["privateKeyType"] = json!(if file.is_some() { "file" } else { "text" });
            auth["oauth1"]["includeBodyHash"] =
                json!(settings.get("include_body_hash") == Some(&json!("true")));
        }
        "akamai-edgegrid" => {
            let mut settings = settings;
            if let Some(size) = settings.get("maxBodySize").and_then(Value::as_str) {
                let size = size.parse::<u64>().map(Value::from).unwrap_or(Value::Null);
                settings.insert("maxBodySize".into(), size);
            }
            auth["akamaiEdgegrid"] = Value::Object(settings);
        }
        other => auth[other] = Value::Object(settings),
    }
}

/// OAuth 2.0 parameters of `auth:oauth2:additional_params:<request>:<place>` blocks.
fn additional(auth: &mut Value, name: &str, pairs: &[Pair]) {
    let mut parts = name.split(':').skip(3);
    let (Some(request), Some(place)) = (parts.next(), parts.next()) else {
        return;
    };
    let group = match request {
        "auth_req" => "authorization",
        "access_token_req" => "token",
        _ => "refresh",
    };
    let rows = &mut auth["oauth2"]["additionalParameters"][group];
    if !rows.is_array() {
        *rows = json!([]);
    }
    if let Some(rows) = rows.as_array_mut() {
        rows.extend(pairs.iter().map(|pair| {
            json!({"name": pair.key, "value": pair.value, "sendIn": place, "enabled": pair.enabled})
        }));
    }
}

/// A part of a multipart body: `@file(a|b)` names files; `@contentType(…)` its type.
fn part(pair: &Pair) -> Value {
    let mut value = pair.value.as_str().unwrap_or_default().trim().to_string();
    let mut content_type = String::new();
    if let Some(at) = value.find("@contentType(") {
        content_type = value[at + 13..]
            .trim_end()
            .trim_end_matches(')')
            .to_string();
        value = value[..at].trim_end().to_string();
    }
    let files = value
        .strip_prefix("@file(")
        .and_then(|v| v.strip_suffix(')'));
    match files {
        Some(files) => {
            let files: Vec<&str> = files.split('|').filter(|f| !f.is_empty()).collect();
            json!({"name": pair.key, "value": files, "enabled": pair.enabled, "type": "file", "contentType": content_type})
        }
        None => {
            json!({"name": pair.key, "value": value, "enabled": pair.enabled, "type": "text", "contentType": content_type})
        }
    }
}

/// The JSON of a `.bru` file: `{meta, http, params, headers, auth, body, script, vars,
/// assertions, tests, docs}`; `auth.mode` and `body.mode` come from the method block or
/// from `auth { mode }` in folders and collections.
pub(super) fn parse(text: &str) -> Value {
    let mut out = json!({
        "meta": {}, "http": {}, "params": [], "headers": [], "auth": {}, "body": {},
        "script": {}, "vars": {"req": [], "res": []}, "assertions": [], "tests": "", "docs": "",
    });
    let mut params = Vec::new();
    for (name, block) in blocks(text) {
        let name = name.as_str();
        match block {
            Block::Text(text) => match name {
                "body" | "body:json" => out["body"]["json"] = json!(text),
                "body:graphql" => out["body"]["graphql"]["query"] = json!(text),
                "body:graphql:vars" => out["body"]["graphql"]["variables"] = json!(text),
                "script:pre-request" => out["script"]["req"] = json!(text),
                "script:post-response" => out["script"]["res"] = json!(text),
                "tests" => out["tests"] = json!(text),
                "docs" => out["docs"] = json!(text),
                _ => {
                    if let Some(kind) = name.strip_prefix("body:") {
                        out["body"][kind] = json!(text);
                    }
                }
            },
            Block::Pairs(pairs) => match name {
                "meta" => out["meta"] = Value::Object(object(&pairs)),
                "http" => {
                    let mut http: Map<String, Value> = object(&pairs);
                    http.entry("method").or_insert(json!("get"));
                    out["http"] = Value::Object(http);
                }
                _ if METHODS.contains(&name) => {
                    let mut http = object(&pairs);
                    http.insert("method".into(), json!(name));
                    out["http"] = Value::Object(http);
                }
                "params:query" | "query" | "params:path" => {
                    let kind = if name == "params:path" {
                        "path"
                    } else {
                        "query"
                    };
                    params.extend(rows(&pairs).into_iter().map(|mut row| {
                        row["type"] = json!(kind);
                        row
                    }));
                }
                "headers" => out["headers"] = json!(rows(&pairs)),
                "auth" => {
                    out["auth"]["mode"] = object(&pairs).get("mode").cloned().unwrap_or_default()
                }
                "body:form-urlencoded" => out["body"]["formUrlEncoded"] = json!(rows(&pairs)),
                "body:multipart-form" => {
                    out["body"]["multipartForm"] =
                        Value::from(pairs.iter().map(part).collect::<Vec<_>>())
                }
                "body:file" => {
                    let files: Vec<Value> = pairs
                        .iter()
                        .map(|pair| {
                            let file = part(pair);
                            json!({"filePath": file["value"][0], "contentType": file["contentType"], "selected": pair.enabled})
                        })
                        .collect();
                    out["body"]["file"] = json!(files);
                }
                "vars:pre-request" => out["vars"]["req"] = json!(rows(&pairs)),
                "vars:post-response" => out["vars"]["res"] = json!(rows(&pairs)),
                "assert" => out["assertions"] = json!(rows(&pairs)),
                _ if name.starts_with("auth:oauth2:additional_params:") => {
                    additional(&mut out["auth"], name, &pairs)
                }
                _ => {
                    if let Some(mode) = name.strip_prefix("auth:") {
                        auth(&mut out["auth"], mode, &pairs);
                    }
                }
            },
            Block::List(_) => {}
        }
    }
    out["params"] = json!(params);
    if let Some(mode) = out["http"].get("auth").cloned() {
        out["auth"]["mode"] = mode;
    }
    if let Some(mode) = out["http"].get("body").cloned() {
        out["body"]["mode"] = mode;
    }
    out
}
