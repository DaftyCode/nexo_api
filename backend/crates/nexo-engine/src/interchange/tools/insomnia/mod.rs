//! Insomnia's exports: v4 (JSON or YAML, `"_type": "export"`) and v5 (YAML,
//! `type: collection.insomnia.rest/5.0`, from Insomnia 11). Base environments become the
//! collection's variables and the environments under them Nexo environments, so that they
//! override them as in Insomnia. Checked against Insomnia's `import-v5-parser.ts` and
//! `models/request.ts` on 2026-11-20.

mod v4;

use super::body::{Part, binary, formdata, graphql, language, raw, urlencoded};
use super::build::{Group, Request, Scripts};
use super::report::{Row, checked, environment, inherit_headers};
use super::{Document, Report, list, text, vars};
use crate::auth::convert::from_insomnia;
use nexo_domain::Result;
use serde_json::{Value, json};

const TOOL: &str = "Insomnia";

pub(super) fn is_export(document: &Value) -> bool {
    (document["_type"] == "export" && document["resources"].is_array())
        || document["type"].as_str().is_some_and(|kind| {
            kind.contains("insomnia.rest/5") || kind.starts_with("mcpClient.insomnia")
        })
}

pub(super) fn import(document: &Value, report: &mut Report) -> Result<Vec<Document>> {
    let collections = if document["_type"] == "export" {
        v4::workspaces(document)
    } else {
        vec![document.clone()]
    };
    let mut documents = Vec::new();
    for collection in &collections {
        let name = text(&collection["name"]);
        let name = if name.is_empty() {
            "Insomnia import".to_string()
        } else {
            name
        };
        let kind = collection["type"].as_str().unwrap_or_default();
        if kind.starts_with("mock.") || kind.starts_with("mcpClient") {
            report.note("unsupported", &name);
            continue;
        }
        if has_spec(&collection["spec"]) {
            report.note("spec", &name);
        }
        if !list(&collection["testSuites"]).is_empty() {
            report.note("tests", &name);
        }
        let environments = &collection["environments"];
        let mut subs = Vec::new();
        for sub in list(&environments["subEnvironments"]) {
            let sub_name = text(&sub["name"]);
            subs.push(Document::environment(environment(
                &sub_name,
                &variables(&sub["data"], &sub["confidentialKeys"]),
            )));
        }
        if kind.starts_with("environment.") {
            // Environments only: the base one is an environment as well.
            if environments.is_object() {
                let base = text(&environments["name"]);
                documents.push(Document::environment(environment(
                    if base.is_empty() { &name } else { &base },
                    &variables(&environments["data"], &environments["confidentialKeys"]),
                )));
            }
            documents.extend(subs);
            continue;
        }
        let inherited = rows(&collection["headers"], &name, report);
        let items = items(list(&collection["collection"]), &inherited, report);
        let group = Group {
            name: name.clone(),
            items,
            auth: authentication(&collection["authentication"], &name, report),
            variables: variables(&environments["data"], &environments["confidentialKeys"]),
            description: text(&collection["meta"]["description"]),
            scripts: scripts(&collection["scripts"]),
        };
        documents.push(Document::collection(group.collection(TOOL, report)));
        documents.extend(subs);
    }
    Ok(documents)
}

/// The authorization of a request, folder or collection, with its variables as Nexo's.
fn authentication(auth: &Value, item: &str, report: &mut Report) -> Option<Value> {
    let auth = vars::each_text(auth, &mut |text| vars::insomnia(text, item, report));
    checked(from_insomnia(&auth), item, report)
}

/// Whether a design document comes with an API specification, which is imported apart (as
/// OpenAPI) and is noted.
fn has_spec(spec: &Value) -> bool {
    spec["file"].is_string()
        || match &spec["contents"] {
            Value::Object(map) => !map.is_empty(),
            Value::String(text) => !text.trim().is_empty(),
            Value::Bool(present) => *present,
            _ => false,
        }
}

fn scripts(scripts: &Value) -> Scripts<'_> {
    Scripts {
        before: vec![scripts["preRequest"].as_str().unwrap_or_default()],
        after: vec![scripts["afterResponse"].as_str().unwrap_or_default()],
        ..Scripts::default()
    }
}

/// Environment data as variables: nested objects with dotted names (`_.api.url` is
/// `{{api.url}}`), confidential keys as secrets.
fn variables(data: &Value, confidential: &Value) -> Vec<Row> {
    fn walk(prefix: &str, value: &Value, rows: &mut Vec<Row>) {
        match value {
            Value::Object(map) => {
                for (key, inner) in map {
                    let name = if prefix.is_empty() {
                        key.clone()
                    } else {
                        format!("{prefix}.{key}")
                    };
                    walk(&name, inner, rows);
                }
            }
            other => rows.push(Row::new(prefix, text(other), true)),
        }
    }
    let mut rows = Vec::new();
    walk("", data, &mut rows);
    let secret: Vec<&str> = list(confidential)
        .iter()
        .filter_map(Value::as_str)
        .collect();
    for row in &mut rows {
        row.secret = secret.contains(&row.key.as_str());
    }
    rows
}

/// Headers or parameters (`[{name, value, disabled}]`).
fn rows(value: &Value, item: &str, report: &mut Report) -> Vec<Row> {
    list(value)
        .iter()
        .map(|row| {
            Row::new(
                vars::insomnia(&text(&row["name"]), item, report),
                vars::insomnia(&text(&row["value"]), item, report),
                row["disabled"] != json!(true),
            )
        })
        .collect()
}

fn kind(item: &Value) -> &str {
    if let Some(kind) = item["_kind"].as_str() {
        return kind;
    }
    let id = item["meta"]["id"].as_str().unwrap_or_default();
    if item["children"].is_array() || id.starts_with("fld_") {
        "group"
    } else if ["greq_", "ws-req", "socketio-req", "mcp"]
        .iter()
        .any(|p| id.starts_with(p))
        || item["method"].is_null()
    {
        "other"
    } else {
        "request"
    }
}

fn items(items: &[Value], inherited: &[Row], report: &mut Report) -> Vec<Value> {
    items
        .iter()
        .filter_map(|item| {
            let name = text(&item["name"]);
            match kind(item) {
                "group" => {
                    let mut headers = rows(&item["headers"], &name, report);
                    inherit_headers(&mut headers, inherited);
                    let group = Group {
                        items: self::items(list(&item["children"]), &headers, report),
                        auth: authentication(&item["authentication"], &name, report),
                        variables: variables(&item["environment"], &item["confidentialKeys"]),
                        description: text(&item["description"])
                            + &text(&item["meta"]["description"]),
                        scripts: scripts(&item["scripts"]),
                        name,
                    };
                    Some(group.folder(TOOL, report))
                }
                "request" => Some(request(item, inherited, report)),
                _ => {
                    report.note("unsupported", &name);
                    None
                }
            }
        })
        .collect()
}

fn request(item: &Value, inherited: &[Row], report: &mut Report) -> Value {
    let name = text(&item["name"]);
    let mut headers = rows(&item["headers"], &name, report);
    inherit_headers(&mut headers, inherited);
    let body = body(&item["body"], &name, report);
    let request = Request {
        method: text(&item["method"]),
        url: vars::insomnia(&text(&item["url"]), &name, report),
        query: rows(&item["parameters"], &name, report),
        path: rows(&item["pathParameters"], &name, report),
        headers,
        body,
        auth: authentication(&item["authentication"], &name, report),
        description: text(&item["description"]) + &text(&item["meta"]["description"]),
        scripts: scripts(&item["scripts"]),
        name,
    };
    request.item(TOOL, report)
}

fn body(body: &Value, item: &str, report: &mut Report) -> Value {
    let media = body["mimeType"].as_str().unwrap_or_default();
    let content = vars::insomnia(&text(&body["text"]), item, report);
    match media {
        "application/x-www-form-urlencoded" => urlencoded(&rows(&body["params"], item, report)),
        "multipart/form-data" => {
            let parts = list(&body["params"])
                .iter()
                .map(|param| Part {
                    row: Row::new(
                        vars::insomnia(&text(&param["name"]), item, report),
                        vars::insomnia(&text(&param["value"]), item, report),
                        param["disabled"] != json!(true),
                    ),
                    files: (param["type"] == "file").then(|| vec![text(&param["fileName"])]),
                    content_type: String::new(),
                })
                .collect();
            formdata(parts, item, report)
        }
        "application/graphql" => {
            let parsed: Value = serde_json::from_str(&content).unwrap_or_default();
            let variables = match &parsed["variables"] {
                Value::Null => String::new(),
                Value::String(text) => text.clone(),
                other => serde_json::to_string_pretty(other).unwrap_or_default(),
            };
            graphql(parsed["query"].as_str().unwrap_or(&content), &variables)
        }
        "application/octet-stream" => binary(&text(&body["fileName"]), item, report),
        "" if content.is_empty() => Value::Null,
        _ => raw(&content, language(media)),
    }
}
