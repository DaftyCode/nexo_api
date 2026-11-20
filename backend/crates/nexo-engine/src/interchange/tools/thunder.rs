//! Thunder Client's exports: a collection (`collectionName`, with `folders` and `requests`
//! joined by `containerId`) or an environment (`environmentName`, `variables`), marked
//! `"client": "Thunder Client"`. Path parameters are written `{id}` and system variables
//! `{{#guid}}`. Its tests are declarative and are noted, not imported.
use super::body::{Part, binary, formdata, graphql, language, raw, urlencoded};
use super::build::{Group, Request, Scripts};
use super::report::{Row, checked, environment, inherit_headers};
use super::{Document, Report, list, text, vars};
use crate::auth::convert::stored;
use nexo_domain::Result;
use serde_json::{Value, json};

const TOOL: &str = "Thunder Client";

fn entries(document: &Value) -> Vec<&Value> {
    match document {
        Value::Array(items) => items.iter().collect(),
        other => vec![other],
    }
}

pub(super) fn is_export(document: &Value) -> bool {
    let entries = entries(document);
    !entries.is_empty()
        && entries.iter().all(|entry| {
            text(&entry["client"])
                .to_ascii_lowercase()
                .contains("thunder")
                && (entry["collectionName"].is_string() || entry["environmentName"].is_string())
        })
}

pub(super) fn import(document: &Value, report: &mut Report) -> Result<Vec<Document>> {
    let mut documents = Vec::new();
    for entry in entries(document) {
        if entry["collectionName"].is_string() {
            documents.push(Document::collection(collection(entry, report)));
        } else {
            let rows: Vec<Row> = list(&entry["variables"])
                .iter()
                .map(|row| {
                    Row::new(
                        text(&row["name"]),
                        vars::thunder(&text(&row["value"])),
                        true,
                    )
                })
                .collect();
            documents.push(Document::environment(environment(
                &text(&entry["environmentName"]),
                &rows,
            )));
        }
    }
    Ok(documents)
}

fn rows(value: &Value) -> Vec<Row> {
    list(value)
        .iter()
        .map(|row| {
            Row::new(
                vars::thunder(&text(&row["name"])),
                vars::thunder(&text(&row["value"])),
                row["isDisabled"] != json!(true),
            )
        })
        .collect()
}

/// Items in Thunder Client's order (`sortNum`).
fn sorted<'a>(items: impl Iterator<Item = &'a Value>) -> Vec<&'a Value> {
    let mut items: Vec<&Value> = items.collect();
    items.sort_by(|a, b| {
        let key = |item: &Value| item["sortNum"].as_f64().unwrap_or(0.0);
        key(a).total_cmp(&key(b))
    });
    items
}

fn collection(export: &Value, report: &mut Report) -> Value {
    let settings = &export["settings"];
    let name = text(&export["collectionName"]);
    if !list(&settings["tests"]).is_empty() {
        report.note("tests", &name);
    }
    let headers = rows(&settings["headers"]);
    let group = Group {
        items: children(export, "", &headers, report),
        auth: checked(auth(&settings["auth"]), &name, report),
        name,
        ..Group::default()
    };
    group.collection(TOOL, report)
}

/// The folders and requests inside `container` (`""` is the collection).
fn children(export: &Value, container: &str, inherited: &[Row], report: &mut Report) -> Vec<Value> {
    let inside = |item: &&Value| text(&item["containerId"]) == container;
    let mut items: Vec<Value> = sorted(list(&export["folders"]).iter().filter(inside))
        .into_iter()
        .map(|folder| {
            let name = text(&folder["name"]);
            let settings = &folder["settings"];
            if !list(&settings["tests"]).is_empty() {
                report.note("tests", &name);
            }
            let mut headers = rows(&settings["headers"]);
            inherit_headers(&mut headers, inherited);
            let group = Group {
                items: children(export, &text(&folder["_id"]), &headers, report),
                auth: checked(auth(&settings["auth"]), &name, report),
                name,
                ..Group::default()
            };
            group.folder(TOOL, report)
        })
        .collect();
    items.extend(
        sorted(list(&export["requests"]).iter().filter(inside))
            .into_iter()
            .map(|item| request(item, inherited, report)),
    );
    items
}

fn request(item: &Value, inherited: &[Row], report: &mut Report) -> Value {
    let name = text(&item["name"]);
    if !list(&item["tests"]).is_empty() {
        report.note("tests", &name);
    }
    let params = list(&item["params"]);
    let pick = |path: bool| -> Vec<Row> {
        params
            .iter()
            .filter(|row| (row["isPath"] == json!(true)) == path)
            .map(|row| {
                Row::new(
                    text(&row["name"]),
                    vars::thunder(&text(&row["value"])),
                    row["isDisabled"] != json!(true),
                )
            })
            .collect()
    };
    let mut headers = rows(&item["headers"]);
    inherit_headers(&mut headers, inherited);
    let request = Request {
        method: text(&item["method"]),
        url: vars::thunder_path(&vars::thunder(&text(&item["url"]))),
        query: pick(false),
        path: pick(true),
        headers,
        body: body(&item["body"], &name, report),
        auth: checked(auth(&item["auth"]), &name, report),
        description: text(&item["docs"]),
        scripts: Scripts::default(),
        name,
    };
    request.item(TOOL, report)
}

fn body(body: &Value, item: &str, report: &mut Report) -> Value {
    let content = vars::thunder(&text(&body["raw"]));
    match body["type"].as_str().unwrap_or("none") {
        "json" => raw(&content, "json"),
        "xml" => raw(&content, "xml"),
        "text" => raw(&content, "text"),
        "html" => raw(&content, language("html")),
        "formencoded" => urlencoded(&rows(&body["form"])),
        "formdata" => {
            let mut parts: Vec<Part> = rows(&body["form"])
                .into_iter()
                .map(|row| Part {
                    row,
                    files: None,
                    content_type: String::new(),
                })
                .collect();
            parts.extend(list(&body["files"]).iter().map(|file| Part {
                row: Row::new(text(&file["name"]), "", file["isDisabled"] != json!(true)),
                files: Some(vec![text(&file["value"])]),
                content_type: String::new(),
            }));
            formdata(parts, item, report)
        }
        "graphql" => graphql(
            &vars::thunder(&text(&body["graphql"]["query"])),
            &vars::thunder(&text(&body["graphql"]["variables"])),
        ),
        "binary" => binary(&text(&body["binary"]), item, report),
        _ => Value::Null,
    }
}

/// Thunder Client's authorization in Postman's format; `None` inherits it.
fn auth(auth: &Value) -> Option<Value> {
    let section = |name: &str, key: &str| json!(vars::thunder(&text(&auth[name][key])));
    Some(match auth["type"].as_str().unwrap_or("inherit") {
        "inherit" | "" => return None,
        "none" => json!({"type": "noauth"}),
        "basic" => stored(
            "basic",
            vec![
                ("username", section("basic", "username")),
                ("password", section("basic", "password")),
            ],
        ),
        "bearer" => {
            let mut pairs = vec![("token", json!(vars::thunder(&text(&auth["bearer"]))))];
            let prefix = text(&auth["bearerPrefix"]);
            if !prefix.is_empty() && prefix != "Bearer" {
                pairs.push(("prefix", json!(prefix)));
            }
            stored("bearer", pairs)
        }
        "ntlm" => stored(
            "ntlm",
            vec![
                ("username", section("ntlm", "username")),
                ("password", section("ntlm", "password")),
                ("domain", section("ntlm", "domain")),
                ("workstation", section("ntlm", "workstation")),
            ],
        ),
        "aws" => stored(
            "awsv4",
            vec![
                ("accessKey", section("aws", "accessKeyId")),
                ("secretKey", section("aws", "secretAccessKey")),
                ("sessionToken", section("aws", "sessionToken")),
                ("service", section("aws", "service")),
                ("region", section("aws", "region")),
            ],
        ),
        "oauth2" => {
            let grant = match text(&auth["oauth2"]["grantType"]).as_str() {
                "password" => "password_credentials",
                "client_credentials" => "client_credentials",
                "implicit" => "implicit",
                _ => "authorization_code",
            };
            stored(
                "oauth2",
                vec![
                    ("grant_type", json!(grant)),
                    ("authUrl", section("oauth2", "authUrl")),
                    ("accessTokenUrl", section("oauth2", "tokenUrl")),
                    ("clientId", section("oauth2", "clientId")),
                    ("clientSecret", section("oauth2", "clientSecret")),
                    ("redirect_uri", section("oauth2", "callbackUrl")),
                    ("scope", section("oauth2", "scope")),
                    ("state", section("oauth2", "state")),
                    ("username", section("oauth2", "username")),
                    ("password", section("oauth2", "password")),
                ],
            )
        }
        other => crate::auth::convert::unknown(other, &auth[other]),
    })
}
