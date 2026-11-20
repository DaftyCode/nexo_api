//! Insomnia's export v4 (`{"_type": "export", "resources": [...]}`): a flat list of
//! resources joined by `parentId`, read here as the tree of the v5 format.
use super::super::list;
use serde_json::{Value, json};

/// Each workspace of the export as a v5 collection: its requests and folders under
/// `collection`, its base environment with the others under `environments`.
pub(super) fn workspaces(export: &Value) -> Vec<Value> {
    let resources = list(&export["resources"]);
    let ids: Vec<&str> = resources.iter().filter_map(|r| r["_id"].as_str()).collect();
    let mut workspaces: Vec<(String, Value)> = resources
        .iter()
        .filter(|r| r["_type"] == "workspace")
        .map(|r| (text(&r["_id"]), r["name"].clone()))
        .collect();
    if workspaces.is_empty() {
        // An export of some requests only: what has no parent in it is at the top.
        let orphan = resources
            .iter()
            .filter(|r| {
                r["parentId"]
                    .as_str()
                    .is_none_or(|parent| !ids.contains(&parent))
            })
            .filter_map(|r| r["parentId"].as_str())
            .next()
            .unwrap_or("")
            .to_string();
        workspaces.push((orphan, json!("Insomnia import")));
    }
    workspaces
        .into_iter()
        .map(|(id, name)| {
            let base = resources
                .iter()
                .find(|r| r["_type"] == "environment" && r["parentId"] == json!(id));
            let mut environments = Value::Null;
            if let Some(base) = base {
                let subs: Vec<Value> = children_of(resources, &text(&base["_id"]))
                    .filter(|r| r["_type"] == "environment")
                    .map(|r| json!({"name": r["name"], "data": r["data"], "isPrivate": r["isPrivate"]}))
                    .collect();
                environments =
                    json!({"name": base["name"], "data": base["data"], "subEnvironments": subs});
            }
            let specs = resources
                .iter()
                .any(|r| r["_type"] == "api_spec" && r["parentId"] == json!(id) && !text(&r["contents"]).trim().is_empty());
            let suites = resources.iter().any(|r| r["_type"] == "unit_test_suite");
            json!({
                "name": name,
                "collection": tree(resources, &id),
                "environments": environments,
                "spec": if specs { json!({"contents": true}) } else { Value::Null },
                "testSuites": if suites { json!([{}]) } else { json!([]) },
            })
        })
        .collect()
}

fn text(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_string()
}

fn children_of<'a>(resources: &'a [Value], parent: &str) -> impl Iterator<Item = &'a Value> {
    let parent = parent.to_string();
    resources
        .iter()
        .filter(move |r| r["parentId"].as_str() == Some(parent.as_str()))
}

/// The requests and folders under `parent`, in Insomnia's order, as v5 items.
fn tree(resources: &[Value], parent: &str) -> Vec<Value> {
    let mut children: Vec<&Value> = children_of(resources, parent)
        .filter(|r| r["_type"] != "environment" && r["_type"] != "cookie_jar")
        .collect();
    children.sort_by(|a, b| {
        let key = |r: &Value| r["metaSortKey"].as_f64().unwrap_or(0.0);
        key(a).total_cmp(&key(b))
    });
    children
        .into_iter()
        .filter_map(|resource| {
            let scripts = json!({
                "preRequest": resource["preRequestScript"],
                "afterResponse": resource["afterResponseScript"],
            });
            match resource["_type"].as_str()? {
                "request_group" => Some(json!({
                    "_kind": "group",
                    "name": resource["name"],
                    "description": resource["description"],
                    "environment": resource["environment"],
                    "headers": resource["headers"],
                    "authentication": resource["authentication"],
                    "scripts": scripts,
                    "children": tree(resources, &text(&resource["_id"])),
                })),
                "request" => {
                    let mut request = resource.clone();
                    request["_kind"] = json!("request");
                    request["scripts"] = scripts;
                    Some(request)
                }
                "grpc_request" | "websocket_request" | "socketio_request" | "mcp_request" => {
                    Some(json!({"_kind": "other", "name": resource["name"]}))
                }
                _ => None,
            }
        })
        .collect()
}
