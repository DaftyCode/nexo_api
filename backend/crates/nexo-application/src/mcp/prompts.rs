//! Prompts: requests for a model built on a workspace's resources.
use super::{resources::*, share::*, uri::*, *};
use nexo_domain::{Document, DocumentKind, Workspace};

impl Application {
    /// A workspace by ID or name; the first one holding `collection` when none is given.
    pub(super) async fn prompt_workspace(
        &self,
        wanted: Option<&str>,
        collection: Option<&str>,
    ) -> std::result::Result<(Workspace, Option<Document>), Missing> {
        let workspaces = self.workspaces().await?;
        let candidates: Vec<Workspace> = match wanted.filter(|w| !w.trim().is_empty()) {
            Some(wanted) => {
                let found = workspaces.into_iter().find(|workspace| {
                    workspace.id.as_str() == wanted || workspace.name.eq_ignore_ascii_case(wanted)
                });
                vec![found.ok_or_else(|| {
                    Missing::Params(format!("There is no workspace named {wanted}"))
                })?]
            }
            None => workspaces,
        };
        let Some(collection) = collection else {
            return candidates
                .into_iter()
                .next()
                .map(|workspace| (workspace, None))
                .ok_or_else(|| Missing::Params("There are no workspaces".into()));
        };
        for workspace in candidates {
            let found = self
                .documents(&workspace.id, Some(DocumentKind::Collection))
                .await?
                .into_iter()
                .find(|document| {
                    document.id.as_str() == collection
                        || document.name.eq_ignore_ascii_case(collection)
                });
            if let Some(found) = found {
                return Ok((workspace, Some(found)));
            }
        }
        Err(Missing::Params(format!(
            "There is no collection named {collection}"
        )))
    }

    /// One prompt with its arguments, as messages that embed the resources it is about.
    pub(crate) async fn mcp_prompt(&self, params: &Value) -> std::result::Result<Value, Missing> {
        let argument = |name: &str| {
            params["arguments"][name]
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
        };
        let required = |name: &str| {
            argument(name)
                .ok_or_else(|| Missing::Params(format!("The argument {name} is required")))
        };
        let (description, instruction, resource_uri, value) = match params["name"]
            .as_str()
            .unwrap_or("")
        {
            "write_tests" => {
                let wanted = required("request")?;
                let (workspace, collection) = self
                    .prompt_workspace(argument("workspace"), Some(required("collection")?))
                    .await?;
                let collection = collection.ok_or(Missing::Resource)?;
                let request = find_request(&collection.value["item"], wanted)
                    .cloned()
                    .ok_or_else(|| {
                        Missing::Params(format!(
                            "There is no request named {wanted} in {}",
                            collection.name
                        ))
                    })?;
                let request_id = request["id"].as_str().unwrap_or(wanted).to_string();
                (
                    "Tests for a request",
                    format!(
                        "Write Postman test scripts for the request \"{}\" of the collection \"{}\". Use pm.test and pm.expect to check the status code, the important headers and the shape and values of the JSON body, and save values later requests need with pm.collectionVariables.set. Answer with the JavaScript for the request's Tests tab, with a short comment for each test.",
                        request["name"].as_str().unwrap_or(wanted),
                        collection.name
                    ),
                    uri(
                        &workspace.id,
                        &[
                            "collections",
                            &encode(collection.id.as_str()),
                            "requests",
                            &encode(&request_id),
                        ],
                    ),
                    request,
                )
            }
            "document_collection" => {
                let (workspace, collection) = self
                    .prompt_workspace(argument("workspace"), Some(required("collection")?))
                    .await?;
                let collection = collection.ok_or(Missing::Resource)?;
                (
                    "Documentation for a collection",
                    format!(
                        "Write Markdown documentation for the API collection \"{}\" ({} requests). Start with an overview and how to authenticate, then a section for each folder and request with its method, URL, parameters, headers, body and what it returns. Mention the variables it needs without inventing their values.",
                        collection.name,
                        request_count(&collection.value["item"])
                    ),
                    uri(
                        &workspace.id,
                        &["collections", &encode(collection.id.as_str())],
                    ),
                    collection.value,
                )
            }
            "explain_failure" => {
                let (workspace, _) = self.prompt_workspace(argument("workspace"), None).await?;
                let execution = self
                    .last_execution(&workspace.id)
                    .await
                    .map_err(|missing| match missing {
                        Missing::Resource => Missing::Params(format!(
                            "The workspace {} has no executions yet",
                            workspace.name
                        )),
                        other => other,
                    })?;
                (
                    "Why the last execution failed",
                    format!(
                        "Explain why this request, the last one sent in the workspace \"{}\", failed or returned an unexpected response. Look at the status, headers, body, test results and errors; say what most likely caused it and how to fix the request, its variables or the server. If it actually succeeded, say so.",
                        workspace.name
                    ),
                    uri(&workspace.id, &["history", "latest"]),
                    execution.value,
                )
            }
            _ => return Err(Missing::Params("Unknown prompt".into())),
        };
        let text = self.redacted(&shareable(&value)).await?;
        Ok(json!({
            "description": description,
            "messages": [
                {"role": "user", "content": {"type": "text", "text": instruction}},
                {"role": "user", "content": {"type": "resource", "resource": {
                    "uri": resource_uri, "mimeType": JSON, "text": text
                }}}
            ]
        }))
    }

    pub(crate) fn mcp_prompts() -> Value {
        let workspace = json!({"name": "workspace", "description": "Workspace name or ID; when omitted, the first one that has the collection", "required": false});
        let collection =
            json!({"name": "collection", "description": "Collection name or ID", "required": true});
        json!({"prompts": [
            {"name": "write_tests", "title": "Write tests for a request",
             "description": "Postman test scripts for one request of a collection",
             "arguments": [collection, {"name": "request", "description": "Request name or ID", "required": true}, workspace]},
            {"name": "explain_failure", "title": "Explain the last execution",
             "description": "Why the last request sent failed, and how to fix it",
             "arguments": [{"name": "workspace", "description": "Workspace name or ID; the first one when omitted", "required": false}]},
            {"name": "document_collection", "title": "Document a collection",
             "description": "Markdown documentation of a collection and its requests",
             "arguments": [collection, workspace]}
        ]})
    }
}
