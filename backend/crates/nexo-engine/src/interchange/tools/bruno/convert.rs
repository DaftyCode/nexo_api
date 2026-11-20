//! A Bruno collection, in the JSON of its exports, as a Nexo collection.
use super::super::body::{Part, binary, formdata, graphql, raw, urlencoded};
use super::super::build::{Group, Request, Scripts, set_variables};
use super::super::report::{Row, checked, inherit_headers};
use super::super::{Report, list, text};
use crate::auth::convert::from_bruno;
use serde_json::{Value, json};
use std::collections::HashMap;

pub(super) const TOOL: &str = "Bruno";

/// The files of a collection folder, by their path inside it, for the OAuth 1.0 private
/// keys that requests name.
pub(super) type Files<'a> = HashMap<String, &'a str>;

fn rows(value: &Value) -> Vec<Row> {
    list(value)
        .iter()
        .map(|row| {
            Row::new(
                text(&row["name"]),
                text(&row["value"]),
                row["enabled"] != json!(false),
            )
        })
        .collect()
}

/// The authorization, with an OAuth 1.0 key file read from the folder: the engine reads no
/// paths. A key that is not there is left empty, with a note.
fn authorization(auth: &Value, files: &Files, item: &str, report: &mut Report) -> Option<Value> {
    let mut auth = auth.clone();
    if auth["oauth1"]["privateKeyType"] == "file" {
        let path = text(&auth["oauth1"]["privateKey"]).replace('\\', "/");
        let key = files.get(path.trim_start_matches("./")).copied();
        if key.is_none() {
            report.note("privateKey", item);
        }
        auth["oauth1"]["privateKey"] = json!(key.unwrap_or_default());
        auth["oauth1"]["privateKeyType"] = json!("text");
    }
    if auth["mode"].is_null() && auth.as_object().is_some_and(|map| !map.is_empty()) {
        auth["mode"] = json!("none");
    }
    checked(from_bruno(&auth), item, report)
}

fn body(body: &Value, item: &str, report: &mut Report) -> Value {
    match body["mode"].as_str().unwrap_or("none") {
        "json" => raw(&text(&body["json"]), "json"),
        "text" | "sparql" => raw(
            &text(&body[body["mode"].as_str().unwrap_or("text")]),
            "text",
        ),
        "xml" => raw(&text(&body["xml"]), "xml"),
        "formUrlEncoded" => urlencoded(&rows(&body["formUrlEncoded"])),
        "multipartForm" => {
            let parts = list(&body["multipartForm"])
                .iter()
                .map(|part| Part {
                    row: Row::new(
                        text(&part["name"]),
                        text(&part["value"]),
                        part["enabled"] != json!(false),
                    ),
                    files: (part["type"] == "file").then(|| match &part["value"] {
                        Value::Array(files) => files.iter().map(text).collect(),
                        other => vec![text(other)],
                    }),
                    content_type: text(&part["contentType"]),
                })
                .collect();
            formdata(parts, item, report)
        }
        "graphql" => graphql(
            &text(&body["graphql"]["query"]),
            &text(&body["graphql"]["variables"]),
        ),
        "file" => {
            let files = list(&body["file"]);
            let chosen = files
                .iter()
                .find(|file| file["selected"] == json!(true))
                .or(files.first());
            binary(
                &chosen
                    .map(|file| text(&file["filePath"]))
                    .unwrap_or_default(),
                item,
                report,
            )
        }
        _ => Value::Null,
    }
}

/// Notes for what Bruno runs after the response that has no form here: variables taken
/// from it and declarative assertions.
fn after_response(request: &Value, item: &str, report: &mut Report) {
    if rows(&request["vars"]["res"]).iter().any(|row| row.enabled) {
        report.note("vars", item);
    }
    if rows(&request["assertions"]).iter().any(|row| row.enabled) {
        report.note("tests", item);
    }
}

fn request(item: &Value, inherited: &[Row], files: &Files, report: &mut Report) -> Value {
    let name = text(&item["name"]);
    let request = &item["request"];
    let params = list(&request["params"]);
    let pick = |kind: &str| -> Vec<Row> {
        params
            .iter()
            .filter(|row| row["type"] == kind || (kind == "query" && row["type"].is_null()))
            .map(|row| {
                Row::new(
                    text(&row["name"]),
                    text(&row["value"]),
                    row["enabled"] != json!(false),
                )
            })
            .collect()
    };
    let mut headers = rows(&request["headers"]);
    inherit_headers(&mut headers, inherited);
    after_response(request, &name, report);
    let converted = Request {
        method: text(&request["method"]),
        url: text(&request["url"]),
        query: pick("query"),
        path: pick("path"),
        headers,
        body: body(&request["body"], &name, report),
        auth: authorization(&request["auth"], files, &name, report),
        description: text(&request["docs"]),
        scripts: Scripts {
            generated: set_variables(&rows(&request["vars"]["req"])),
            before: vec![request["script"]["req"].as_str().unwrap_or_default()],
            after: vec![
                request["script"]["res"].as_str().unwrap_or_default(),
                request["tests"].as_str().unwrap_or_default(),
            ],
        },
        name,
    };
    converted.item(TOOL, report)
}

/// A folder or the collection: what its `root` (folder.bru, collection.bru) sets.
pub(super) fn group<'a>(
    name: String,
    root: &'a Value,
    items: &'a [Value],
    inherited: &[Row],
    files: &Files,
    report: &mut Report,
) -> Group<'a> {
    let settings = &root["request"];
    let mut headers = rows(&settings["headers"]);
    inherit_headers(&mut headers, inherited);
    after_response(settings, &name, report);
    let items = items
        .iter()
        .filter_map(|item| {
            let item_name = text(&item["name"]);
            match item["type"].as_str().unwrap_or_default() {
                "folder" => Some(
                    group(
                        item_name,
                        &item["root"],
                        list(&item["items"]),
                        &headers,
                        files,
                        report,
                    )
                    .folder(TOOL, report),
                ),
                "http-request" | "graphql-request" => Some(request(item, &headers, files, report)),
                _ => {
                    report.note("unsupported", &item_name);
                    None
                }
            }
        })
        .collect();
    let mut auth = settings["auth"].clone();
    if auth.is_null() {
        auth = json!({"mode": "inherit"});
    }
    let script = |value: &'a Value| value.as_str().unwrap_or_default();
    let scripts = Scripts {
        before: vec![script(&settings["script"]["req"])],
        after: vec![
            script(&settings["script"]["res"]),
            script(&settings["tests"]),
        ],
        ..Scripts::default()
    };
    Group {
        auth: authorization(&auth, files, &name, report),
        variables: rows(&settings["vars"]["req"]),
        description: text(&root["docs"]),
        items,
        scripts,
        name,
    }
}
