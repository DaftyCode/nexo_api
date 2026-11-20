//! Hoppscotch's exports: collections (one, or a list of them, with `folders` and
//! `requests`) and environments (`{name, variables}`, or a list). Its `<<name>>` variables
//! become `{{name}}`. Checked against `hoppscotch-data` (request schemas v1 to v17) on
//! 2026-11-20.
use super::body::{Part, binary, formdata, language, raw, urlencoded};
use super::build::{Group, Request, Scripts, set_variables};
use super::report::{Row, checked, environment, inherit_headers};
use super::{Document, Report, list, text, vars};
use crate::auth::convert::stored;
use nexo_domain::Result;
use serde_json::{Value, json};

const TOOL: &str = "Hoppscotch";

fn entries(document: &Value) -> Vec<&Value> {
    match document {
        Value::Array(items) => items.iter().collect(),
        other => vec![other],
    }
}

fn is_collection(value: &Value) -> bool {
    value["folders"].is_array() && value["requests"].is_array()
}

fn is_environment(value: &Value) -> bool {
    value["name"].is_string()
        && value["variables"].is_array()
        && list(&value["variables"])
            .iter()
            .all(|row| row["key"].is_string())
}

pub(super) fn is_export(document: &Value) -> bool {
    let entries = entries(document);
    !entries.is_empty()
        && (entries.iter().all(|entry| is_collection(entry))
            || entries.iter().all(|entry| is_environment(entry)))
}

pub(super) fn import(document: &Value, report: &mut Report) -> Result<Vec<Document>> {
    let mut documents = Vec::new();
    for entry in entries(document) {
        if is_collection(entry) {
            documents.push(Document::collection(
                group(entry, &[], report).collection(TOOL, report),
            ));
        } else {
            let rows: Vec<Row> = list(&entry["variables"])
                .iter()
                .map(|row| {
                    let mut variable = Row::new(text(&row["key"]), value(row), true);
                    variable.secret = row["secret"] == json!(true);
                    variable
                })
                .collect();
            documents.push(Document::environment(environment(
                &text(&entry["name"]),
                &rows,
            )));
        }
    }
    Ok(documents)
}

/// The value of a variable: older exports have `value`, newer ones an initial and a
/// current value.
fn value(row: &Value) -> String {
    let pick = ["currentValue", "initialValue", "value"]
        .iter()
        .map(|key| text(&row[*key]))
        .find(|value| !value.is_empty());
    vars::hoppscotch(&pick.unwrap_or_default())
}

fn rows(value: &Value) -> Vec<Row> {
    list(value)
        .iter()
        .map(|row| {
            Row::new(
                vars::hoppscotch(&text(&row["key"])),
                vars::hoppscotch(&text(&row["value"])),
                row["active"] != json!(false),
            )
        })
        .collect()
}

fn group<'a>(collection: &'a Value, inherited: &[Row], report: &mut Report) -> Group<'a> {
    let name = text(&collection["name"]);
    let mut headers = rows(&collection["headers"]);
    inherit_headers(&mut headers, inherited);
    let mut items: Vec<Value> = list(&collection["folders"])
        .iter()
        .map(|folder| group(folder, &headers, report).folder(TOOL, report))
        .collect();
    items.extend(
        list(&collection["requests"])
            .iter()
            .map(|request| self::request(request, &headers, report)),
    );
    let variables = list(&collection["variables"])
        .iter()
        .map(|row| {
            let mut variable = Row::new(text(&row["key"]), value(row), true);
            variable.secret = row["secret"] == json!(true);
            variable
        })
        .collect();
    Group {
        auth: checked(auth(&collection["auth"]), &name, report),
        variables,
        description: text(&collection["description"]),
        scripts: Scripts {
            before: vec![collection["preRequestScript"].as_str().unwrap_or_default()],
            after: vec![collection["testScript"].as_str().unwrap_or_default()],
            ..Scripts::default()
        },
        items,
        name,
    }
}

fn request(item: &Value, inherited: &[Row], report: &mut Report) -> Value {
    let name = text(&item["name"]);
    let mut headers = rows(&item["headers"]);
    inherit_headers(&mut headers, inherited);
    let request = Request {
        method: text(&item["method"]),
        url: vars::hoppscotch(&text(&item["endpoint"])),
        query: rows(&item["params"]),
        headers,
        body: body(&item["body"], &name, report),
        auth: checked(auth(&item["auth"]), &name, report),
        description: text(&item["description"]),
        scripts: Scripts {
            generated: set_variables(&rows(&item["requestVariables"])),
            before: vec![item["preRequestScript"].as_str().unwrap_or_default()],
            after: vec![item["testScript"].as_str().unwrap_or_default()],
        },
        name,
        ..Request::default()
    };
    request.item(TOOL, report)
}

fn body(body: &Value, item: &str, report: &mut Report) -> Value {
    let media = body["contentType"].as_str().unwrap_or_default();
    match media {
        "" => Value::Null,
        "multipart/form-data" => {
            let parts = list(&body["body"])
                .iter()
                .map(|part| Part {
                    row: Row::new(
                        vars::hoppscotch(&text(&part["key"])),
                        vars::hoppscotch(&text(&part["value"])),
                        part["active"] != json!(false),
                    ),
                    files: (part["isFile"] == json!(true)).then(|| vec![text(&part["key"])]),
                    content_type: text(&part["contentType"]),
                })
                .collect();
            formdata(parts, item, report)
        }
        // A text of `key: value` lines; `#` turns one off.
        "application/x-www-form-urlencoded" => urlencoded(
            &text(&body["body"])
                .lines()
                .filter_map(|line| {
                    let (enabled, line) = match line.trim().strip_prefix('#') {
                        Some(rest) => (false, rest),
                        None => (true, line.trim()),
                    };
                    let (key, value) = line.split_once(':')?;
                    Some(Row::new(
                        vars::hoppscotch(key.trim()),
                        vars::hoppscotch(value.trim()),
                        enabled,
                    ))
                })
                .collect::<Vec<_>>(),
        ),
        "application/octet-stream" => binary("", item, report),
        _ => raw(&vars::hoppscotch(&text(&body["body"])), language(media)),
    }
}

/// Hoppscotch's authorization (`authType`) in Postman's format; `None` inherits it.
fn auth(auth: &Value) -> Option<Value> {
    if auth["authActive"] == json!(false) {
        return Some(json!({"type": "noauth"}));
    }
    let field = |key: &str| json!(vars::hoppscotch(&text(&auth[key])));
    let place = |key: &str| {
        if text(&auth[key]).to_ascii_lowercase().contains("query") {
            "query"
        } else {
            "header"
        }
    };
    Some(match auth["authType"].as_str().unwrap_or("inherit") {
        "inherit" => return None,
        "none" => json!({"type": "noauth"}),
        "basic" => stored(
            "basic",
            vec![
                ("username", field("username")),
                ("password", field("password")),
            ],
        ),
        "bearer" => stored("bearer", vec![("token", field("token"))]),
        "api-key" => stored(
            "apikey",
            vec![
                ("key", field("key")),
                ("value", field("value")),
                ("in", json!(place("addTo"))),
            ],
        ),
        "digest" => stored(
            "digest",
            vec![
                ("username", field("username")),
                ("password", field("password")),
                ("realm", field("realm")),
                ("nonce", field("nonce")),
                ("algorithm", field("algorithm")),
                ("qop", field("qop")),
                ("nonceCount", field("nc")),
                ("clientNonce", field("cnonce")),
                ("opaque", field("opaque")),
                ("disableRetryRequest", auth["disableRetry"].clone()),
            ],
        ),
        "aws-signature" => stored(
            "awsv4",
            vec![
                ("accessKey", field("accessKey")),
                ("secretKey", field("secretKey")),
                ("region", field("region")),
                ("service", field("serviceName")),
                ("sessionToken", field("serviceToken")),
                ("addAuthDataToQuery", json!(place("addTo") == "query")),
            ],
        ),
        "oauth-2" => oauth2(auth, place("addTo")),
        other => crate::auth::convert::unknown(other, auth),
    })
}

fn oauth2(auth: &Value, place: &str) -> Value {
    let info = &auth["grantTypeInfo"];
    let field = |key: &str| json!(vars::hoppscotch(&text(&info[key])));
    let (grant, token_url) = match info["grantType"].as_str().unwrap_or_default() {
        "AUTHORIZATION_CODE" if info["isPKCE"] == json!(true) => {
            ("authorization_code_with_pkce", "tokenEndpoint")
        }
        "AUTHORIZATION_CODE" => ("authorization_code", "tokenEndpoint"),
        "PASSWORD" => ("password_credentials", "authEndpoint"),
        "IMPLICIT" => ("implicit", ""),
        _ => ("client_credentials", "authEndpoint"),
    };
    let mut pairs = vec![
        ("grant_type", json!(grant)),
        ("clientId", field("clientID")),
        ("clientSecret", field("clientSecret")),
        ("scope", field("scopes")),
        ("username", field("username")),
        ("password", field("password")),
        ("accessToken", field("token")),
        ("challengeAlgorithm", field("codeVerifierMethod")),
        (
            "addTokenTo",
            json!(if place == "query" {
                "queryParams"
            } else {
                "header"
            }),
        ),
    ];
    if grant.starts_with("authorization_code") || grant == "implicit" {
        pairs.push(("authUrl", field("authEndpoint")));
    }
    if !token_url.is_empty() {
        pairs.push(("accessTokenUrl", field(token_url)));
    }
    stored(
        "oauth2",
        pairs.into_iter().filter(|(_, v)| v != &json!("")).collect(),
    )
}
