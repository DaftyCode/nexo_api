//! Bruno collections: a folder of `.bru` files with its `bruno.json` (the interface sends
//! its files, since the engine reads no paths), or the JSON Bruno exports. Checked against
//! `bruno-lang` v2 on 2026-11-20.

mod convert;
mod lang;
mod request;

use super::report::{Row, environment};
use super::{Document, Report, list, text};
use convert::{Files, TOOL, group};
use nexo_domain::{Error, Result};
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// Files of a folder read, at most.
const MAX_FILES: usize = 5000;

pub(super) fn is_export(document: &Value) -> bool {
    document["items"].is_array()
        && (document["brunoConfig"].is_object() || document["version"] == "1")
}

/// The collection and environments of Bruno's JSON export.
pub(super) fn export(document: &Value, report: &mut Report) -> Result<Vec<Document>> {
    Ok(collection(
        text(&document["name"]),
        &document["root"],
        list(&document["items"]),
        list(&document["environments"]),
        &Files::new(),
        report,
    ))
}

fn collection(
    name: String,
    root: &Value,
    items: &[Value],
    environments: &[Value],
    files: &Files,
    report: &mut Report,
) -> Vec<Document> {
    let name = if name.trim().is_empty() {
        "Bruno import".to_string()
    } else {
        name
    };
    let mut documents = vec![Document::collection(
        group(name, root, items, &[], files, report).collection(TOOL, report),
    )];
    for env in environments {
        let name = text(&env["name"]);
        let rows: Vec<Row> = list(&env["variables"])
            .iter()
            .map(|row| {
                let mut variable = Row::new(
                    text(&row["name"]),
                    text(&row["value"]),
                    row["enabled"] != json!(false),
                );
                variable.secret = row["secret"] == json!(true);
                if variable.secret && variable.value.is_empty() {
                    report.note("secret", &format!("{name}: {}", variable.key));
                }
                variable
            })
            .collect();
        documents.push(Document::environment(environment(&name, &rows)));
    }
    documents
}

/// The files of a collection folder (`[{path, content}]`) as the collection: the folder is
/// the one with `bruno.json`; `collection.bru` and each `folder.bru` set what their
/// requests inherit, and `environments/*.bru` are its environments.
pub(super) fn folder(files: &[Value], report: &mut Report) -> Result<Vec<Document>> {
    if files.len() > MAX_FILES {
        return Err(Error::Validation(format!(
            "A Bruno collection can have at most {MAX_FILES} files"
        )));
    }
    let paths: Vec<(String, &str)> = files
        .iter()
        .map(|file| {
            let path = text(&file["path"]).replace('\\', "/");
            (
                path.trim_start_matches("./").to_string(),
                file["content"].as_str().unwrap_or_default(),
            )
        })
        .collect();
    let config = paths
        .iter()
        .filter(|(path, _)| path == "bruno.json" || path.ends_with("/bruno.json"))
        .min_by_key(|(path, _)| path.len())
        .ok_or_else(|| {
            Error::Validation(
                "Choose the folder of a Bruno collection, the one with bruno.json".into(),
            )
        })?;
    let base = config.0.trim_end_matches("bruno.json").to_string();
    let inside: Files = paths
        .iter()
        .filter_map(|(path, content)| Some((path.strip_prefix(&base)?.to_string(), *content)))
        .filter(|(path, _)| {
            !path
                .split('/')
                .any(|part| part == "node_modules" || part.starts_with('.'))
        })
        .collect();
    let settings: Value = serde_json::from_str(config.1).unwrap_or_default();
    let mut environments = Vec::new();
    for (path, content) in &inside {
        if let Some(file) = path.strip_prefix("environments/")
            && let Some(name) = file.strip_suffix(".bru")
            && !name.contains('/')
        {
            environments.push(json!({"name": name, "variables": lang::environment(content)}));
        }
    }
    environments.sort_by_key(|env| text(&env["name"]));
    let root = inside
        .get("collection.bru")
        .map(|text| root(text))
        .unwrap_or_default();
    let items = tree(&inside, "");
    Ok(collection(
        text(&settings["name"]),
        &root,
        &items,
        &environments,
        &inside,
        report,
    ))
}

/// What a `collection.bru` or `folder.bru` sets, as the `root` of Bruno's JSON.
fn root(content: &str) -> Value {
    let parsed = request::parse(content);
    let mut root =
        json!({"request": parsed.clone(), "docs": parsed["docs"], "meta": parsed["meta"]});
    if parsed["auth"]["mode"].is_null() {
        root["request"]["auth"]["mode"] = json!("inherit");
    }
    root
}

/// The items of the folder at `dir` (`""` or `users/`): its requests and its folders, in
/// the order of their `seq`.
fn tree(files: &Files, dir: &str) -> Vec<Value> {
    let mut items: Vec<Value> = Vec::new();
    let mut folders = BTreeSet::new();
    for (path, content) in files {
        let Some(rest) = path.strip_prefix(dir) else {
            continue;
        };
        if dir.is_empty() && (rest.starts_with("environments/") || rest == "collection.bru") {
            continue;
        }
        match rest.split_once('/') {
            Some((folder, _)) if path.ends_with(".bru") => {
                folders.insert(folder.to_string());
            }
            None if rest.ends_with(".bru") && rest != "folder.bru" => {
                let parsed = request::parse(content);
                let kind = match parsed["meta"]["type"].as_str().unwrap_or("http") {
                    "graphql" => "graphql-request",
                    "http" => "http-request",
                    other => other,
                };
                let mut request = parsed.clone();
                request["method"] = parsed["http"]["method"].clone();
                request["url"] = parsed["http"]["url"].clone();
                let name = text(&parsed["meta"]["name"]);
                items.push(json!({
                    "type": kind,
                    "name": if name.is_empty() { rest.trim_end_matches(".bru").to_string() } else { name },
                    "seq": sequence(&parsed["meta"]["seq"]),
                    "request": request,
                }));
            }
            _ => {}
        }
    }
    for folder in folders {
        let path = format!("{dir}{folder}/");
        let root = files
            .get(&format!("{path}folder.bru"))
            .map(|content| root(content))
            .unwrap_or_else(|| json!({"request": {"auth": {"mode": "inherit"}}}));
        let name = text(&root["meta"]["name"]);
        items.push(json!({
            "type": "folder",
            "name": if name.is_empty() { folder } else { name },
            "seq": sequence(&root["meta"]["seq"]),
            "items": tree(files, &path),
            "root": root,
        }));
    }
    items.sort_by(|a, b| {
        let seq = |item: &Value| item["seq"].as_f64().unwrap_or(f64::MAX);
        seq(a)
            .total_cmp(&seq(b))
            .then_with(|| text(&a["name"]).cmp(&text(&b["name"])))
    });
    items
}

fn sequence(value: &Value) -> Value {
    match value {
        Value::String(text) => text
            .trim()
            .parse::<f64>()
            .map(Value::from)
            .unwrap_or(Value::Null),
        other => other.clone(),
    }
}
