//! The tree of a Drillbit: its enabled storage plugins, their schemas (`SHOW SCHEMAS`),
//! tables, views and the files of a workspace (`SHOW FILES`), and their columns
//! (`INFORMATION_SCHEMA`). A plugin's configuration is shown without its credentials.
use crate::{rest::Drill, values::rows};
use nexo_driver_sdk::{
    DriverError, Result, Value,
    protocol::{Ddl, ObjectDescription, Property, Section, TreeNode},
};
use serde_json::Value as Json;

fn node(
    kind: &str,
    name: &str,
    label: &str,
    detail: Option<String>,
    children: bool,
    actions: &[&str],
) -> TreeNode {
    TreeNode {
        kind: kind.into(),
        name: name.into(),
        label: label.into(),
        detail,
        has_children: children,
        actions: actions.iter().map(|action| (*action).to_owned()).collect(),
        system: false,
    }
}

/// A text as a string of Drill SQL.
fn literal(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

fn text(value: &Value) -> String {
    match value {
        Value::Text(text) | Value::Typed { text, .. } => text.clone(),
        Value::Integer(number) => number.to_string(),
        Value::Bool(flag) => flag.to_string(),
        _ => String::new(),
    }
}

/// The rows of a statement of the catalog.
async fn read(drill: &Drill, sql: &str) -> Result<Vec<Vec<Value>>> {
    let (_, found) = rows(&drill.query(sql, None).await?);
    Ok(found)
}

pub(crate) async fn tree(drill: &Drill, path: &[String]) -> Result<Vec<TreeNode>> {
    let path: Vec<&str> = path.iter().map(String::as_str).collect();
    Ok(match path.as_slice() {
        [] => drill
            .send("GET", "/storage.json", None)
            .await?
            .as_array()
            .into_iter()
            .flatten()
            // Drill leaves `enabled` out of a disabled plugin.
            .filter(|plugin| plugin["config"]["enabled"].as_bool() == Some(true))
            .map(|plugin| {
                let name = plugin["name"].as_str().unwrap_or_default();
                let kind = plugin["config"]["type"].as_str().map(str::to_owned);
                node("database", name, name, kind, true, &["open"])
            })
            .collect(),
        [plugin] => read(drill, "SHOW SCHEMAS")
            .await?
            .iter()
            .map(|row| text(&row[0]))
            .filter(|schema| schema == plugin || schema.starts_with(&format!("{plugin}.")))
            // Its whole name (`dfs.tmp`), as a statement writes it before a table.
            .map(|schema| node("schema", &schema, &schema, None, true, &[]))
            .collect(),
        [_, schema] => {
            let sql = format!(
                "SELECT TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.`TABLES` WHERE TABLE_SCHEMA = {} ORDER BY TABLE_NAME",
                literal(schema)
            );
            let mut found: Vec<TreeNode> = read(drill, &sql)
                .await?
                .iter()
                .map(|row| {
                    let name = text(&row[0]);
                    let view = text(&row[1]) == "VIEW";
                    node(
                        if view { "view" } else { "table" },
                        &name,
                        &name,
                        None,
                        true,
                        &["open", "data"],
                    )
                })
                .collect();
            // The files of a workspace are tables too; other schemas have none to list.
            if let Ok(files) = read(
                drill,
                &format!("SHOW FILES IN `{}`", schema.replace('`', "")),
            )
            .await
            {
                for row in files {
                    let name = text(&row[0]);
                    if !found.iter().any(|known| known.name == name) {
                        let detail = if text(&row[1]) == "true" {
                            "folder"
                        } else {
                            "file"
                        };
                        found.push(node(
                            "table",
                            &name,
                            &name,
                            Some(detail.into()),
                            false,
                            &["open", "data"],
                        ));
                    }
                }
            }
            found
        }
        [_, schema, table] => {
            let sql = format!(
                "SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.`COLUMNS` WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} ORDER BY ORDINAL_POSITION",
                literal(schema),
                literal(table)
            );
            read(drill, &sql)
                .await?
                .iter()
                .map(|row| {
                    node(
                        "column",
                        &text(&row[0]),
                        &text(&row[0]),
                        Some(text(&row[1])),
                        false,
                        &[],
                    )
                })
                .collect()
        }
        _ => Vec::new(),
    })
}

/// Whether a field of a configuration holds a secret.
fn secret(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    ["password", "secret", "token", "credential", "key", "auth"]
        .iter()
        .any(|word| lower.contains(word))
}

/// A configuration without its secrets: a field that names one, and the password of a URL
/// (`mongodb://user:password@host`).
pub(crate) fn redacted(value: &Json) -> Json {
    match value {
        Json::Object(fields) => Json::Object(
            fields
                .iter()
                .map(|(name, inner)| {
                    let shown = if secret(name) && !inner.is_null() && !inner.is_boolean() {
                        Json::String("[redacted]".into())
                    } else {
                        redacted(inner)
                    };
                    (name.clone(), shown)
                })
                .collect(),
        ),
        Json::Array(items) => Json::Array(items.iter().map(redacted).collect()),
        Json::String(text) => Json::String(without_url_password(text)),
        other => other.clone(),
    }
}

fn without_url_password(text: &str) -> String {
    let Some(scheme) = text.find("://") else {
        return text.to_owned();
    };
    let rest = &text[scheme + 3..];
    match (rest.find('@'), rest.find(':')) {
        (Some(at), Some(colon)) if colon < at && !rest[..at].contains('/') => {
            format!(
                "{}{}:[redacted]{}",
                &text[..scheme + 3],
                &rest[..colon],
                &rest[at..]
            )
        }
        _ => text.to_owned(),
    }
}

async fn plugin(drill: &Drill, name: &str) -> Result<Json> {
    if name.contains(['/', '?', '#', '.']) {
        return Err(DriverError::invalid("A storage plugin is a single name"));
    }
    drill
        .send("GET", &format!("/storage/{name}.json"), None)
        .await
}

pub(crate) async fn describe(drill: &Drill, path: &[String]) -> Result<ObjectDescription> {
    let [name] = path else {
        return Err(DriverError::invalid("Only a storage plugin has a sheet"));
    };
    let found = plugin(drill, name).await?;
    let config = redacted(&found["config"]);
    let rows = config
        .as_object()
        .into_iter()
        .flatten()
        .map(|(field, value)| {
            let shown = value
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| value.to_string());
            vec![Value::Text(field.clone()), Value::Text(shown)]
        })
        .collect();
    Ok(ObjectDescription {
        kind: "database".into(),
        name: name.clone(),
        properties: vec![
            Property {
                name: "Type".into(),
                value: Value::Text(config["type"].as_str().unwrap_or_default().into()),
            },
            Property {
                name: "Enabled".into(),
                value: Value::Bool(config["enabled"].as_bool().unwrap_or(false)),
            },
        ],
        sections: vec![Section {
            id: "configuration".into(),
            title: "Configuration".into(),
            columns: vec!["Setting".into(), "Value".into()],
            rows,
        }],
    })
}

pub(crate) async fn ddl(drill: &Drill, path: &[String]) -> Result<Ddl> {
    let [name] = path else {
        return Err(DriverError::invalid(
            "Only a storage plugin has a configuration",
        ));
    };
    let found = plugin(drill, name).await?;
    Ok(Ddl {
        sql: serde_json::to_string_pretty(&redacted(&found["config"])).unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_configuration_is_shown_without_its_secrets() {
        let config = json!({
            "type": "mongo",
            "connection": "mongodb://ana:s3cret@db:27017/",
            "credentialsProvider": {"credentials": {"username": "ana", "password": "s3cret"}},
            "enabled": true,
            "secretKey": "abc",
            "workspaces": {"tmp": {"location": "/tmp"}},
            "urls": ["http://plain/x", "https://u:p@h/y"]
        });
        let shown = redacted(&config).to_string();
        assert!(
            !shown.contains("s3cret") && !shown.contains("abc") && !shown.contains("u:p@"),
            "{shown}"
        );
        assert!(shown.contains("mongodb://ana:[redacted]@db:27017/"));
        assert!(shown.contains("\"enabled\":true"));
        assert!(shown.contains("/tmp"));
        assert_eq!(literal("it's"), "'it''s'");
    }
}
