//! The tree of a cluster: its indices (with their fields, the mapping flattened), data
//! streams, aliases, index templates and nodes; an index's sheet and the request that makes
//! it again.
use crate::{error::answer_error, http::Client};
use nexo_driver_sdk::{Result, protocol::TreeNode};
use serde_json::Value as Json;

fn node(
    kind: &str,
    name: &str,
    detail: Option<String>,
    children: bool,
    actions: &[&str],
) -> TreeNode {
    TreeNode {
        kind: kind.into(),
        name: name.into(),
        label: name.into(),
        detail,
        has_children: children,
        actions: actions.iter().map(|action| (*action).to_owned()).collect(),
        system: false,
    }
}

const FOLDERS: [(&str, &str); 5] = [
    ("indices", "Indices"),
    ("data-streams", "Data streams"),
    ("aliases", "Aliases"),
    ("templates", "Index templates"),
    ("cluster", "Cluster nodes"),
];

/// A request that reads, and its answer as JSON.
pub(crate) async fn get(client: &Client, path: &str) -> Result<Json> {
    let answer = client.send("GET", path, None).await?;
    if answer.status >= 400 {
        return Err(answer_error(&answer));
    }
    answer.json()
}

/// The fields of a mapping, flattened: `user.address.city` with its type; an object's
/// fields under it, a multi-field (`name.keyword`) too.
pub(crate) fn fields(properties: &Json, prefix: &str, out: &mut Vec<(String, String)>) {
    let Some(properties) = properties.as_object() else {
        return;
    };
    for (name, field) in properties {
        let path = format!("{prefix}{name}");
        let kind = field["type"]
            .as_str()
            .unwrap_or(if field["properties"].is_object() {
                "object"
            } else {
                "unknown"
            });
        out.push((path.clone(), kind.to_owned()));
        fields(&field["properties"], &format!("{path}."), out);
        fields(&field["fields"], &format!("{path}."), out);
    }
}

fn text(value: &Json) -> String {
    match value {
        Json::String(text) => text.clone(),
        Json::Null => String::new(),
        other => other.to_string(),
    }
}

async fn index_fields(client: &Client, index: &str) -> Result<Vec<(String, String)>> {
    let mapping = get(client, &format!("/{index}/_mapping")).await?;
    let mut found = Vec::new();
    if let Some(indices) = mapping.as_object() {
        for value in indices.values() {
            fields(&value["mappings"]["properties"], "", &mut found);
        }
    }
    Ok(found)
}

pub(crate) async fn tree(client: &Client, path: &[String]) -> Result<Vec<TreeNode>> {
    let path: Vec<&str> = path.iter().map(String::as_str).collect();
    Ok(match path.as_slice() {
        [] => FOLDERS
            .iter()
            .map(|(name, label)| TreeNode {
                label: (*label).into(),
                system: *name == "cluster",
                ..node("folder", name, None, true, &[])
            })
            .collect(),
        ["indices"] => {
            let list = get(
                client,
                "/_cat/indices?format=json&h=index,health,status,docs.count,store.size&s=index",
            )
            .await?;
            list.as_array()
                .into_iter()
                .flatten()
                .map(|row| {
                    let name = text(&row["index"]);
                    let detail = format!(
                        "{} docs · {}",
                        text(&row["docs.count"]),
                        text(&row["store.size"])
                    );
                    TreeNode {
                        system: name.starts_with('.'),
                        ..node("table", &name, Some(detail), true, &["open", "data", "ddl"])
                    }
                })
                .collect()
        }
        ["indices", index] => index_fields(client, index)
            .await?
            .into_iter()
            .map(|(name, kind)| node("column", &name, Some(kind), false, &[]))
            .collect(),
        ["data-streams"] => get(client, "/_data_stream").await?["data_streams"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|stream| {
                node(
                    "view",
                    &text(&stream["name"]),
                    Some(text(&stream["status"])),
                    false,
                    &["open", "data"],
                )
            })
            .collect(),
        ["aliases"] => get(client, "/_cat/aliases?format=json&s=alias")
            .await?
            .as_array()
            .into_iter()
            .flatten()
            .map(|row| {
                node(
                    "synonym",
                    &text(&row["alias"]),
                    Some(text(&row["index"])),
                    false,
                    &["open", "data"],
                )
            })
            .collect(),
        ["templates"] => get(client, "/_index_template").await?["index_templates"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|template| node("template", &text(&template["name"]), None, false, &["ddl"]))
            .collect(),
        ["cluster"] => get(
            client,
            "/_cat/nodes?format=json&h=name,ip,node.role,master,heap.percent",
        )
        .await?
        .as_array()
        .into_iter()
        .flatten()
        .map(|row| {
            let master = if text(&row["master"]) == "*" {
                " · master"
            } else {
                ""
            };
            let detail = format!(
                "{} · {}{master} · heap {}%",
                text(&row["ip"]),
                text(&row["node.role"]),
                text(&row["heap.percent"])
            );
            node("node", &text(&row["name"]), Some(detail), false, &[])
        })
        .collect(),
        _ => Vec::new(),
    })
}

mod sheet;
pub(crate) use sheet::{ddl, describe};

#[cfg(test)]
mod tests {
    use super::*;
    use nexo_driver_sdk::Value;
    use serde_json::json;
    use sheet::flatten;

    #[test]
    fn a_mapping_is_flattened_with_its_objects_and_multi_fields() {
        let mapping = json!({
            "name": {"type": "text", "fields": {"keyword": {"type": "keyword"}}},
            "user": {"properties": {"address": {"properties": {"city": {"type": "keyword"}}}}},
            "at": {"type": "date"}
        });
        let mut found = Vec::new();
        fields(&mapping, "", &mut found);
        let names: Vec<&str> = found.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(
            names,
            [
                "name",
                "name.keyword",
                "user",
                "user.address",
                "user.address.city",
                "at"
            ]
        );
        assert_eq!(found[2].1, "object");
        let mut rows = Vec::new();
        flatten(&json!({"index": {"number_of_shards": "1"}}), "", &mut rows);
        assert_eq!(
            rows,
            [vec![
                Value::Text("index.number_of_shards".into()),
                Value::Text("1".into())
            ]]
        );
    }
}
