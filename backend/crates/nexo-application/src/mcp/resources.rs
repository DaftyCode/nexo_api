//! Resources: the collections, requests, environments, globals and last execution of every
//! workspace, without their secrets.
use super::{share::*, uri::*, *};
use nexo_domain::{Document, DocumentKind, Result, WorkspaceId};

pub(super) const JSON: &str = "application/json";

/// The request of a collection with this identifier or name, depth first.
pub(super) fn find_request<'a>(items: &'a Value, wanted: &str) -> Option<&'a Value> {
    for item in items.as_array()? {
        if item.get("request").is_some()
            && (item["id"].as_str() == Some(wanted)
                || item["name"]
                    .as_str()
                    .is_some_and(|name| name.eq_ignore_ascii_case(wanted)))
        {
            return Some(item);
        }
        if let Some(found) = item
            .get("item")
            .and_then(|items| find_request(items, wanted))
        {
            return Some(found);
        }
    }
    None
}

/// Requests of a collection, for the resource templates' completion and prompt hints.
pub(super) fn request_count(items: &Value) -> usize {
    items.as_array().map_or(0, |items| {
        items
            .iter()
            .map(|item| usize::from(item.get("request").is_some()) + request_count(&item["item"]))
            .sum()
    })
}

impl Application {
    /// The resources of every workspace.
    pub(crate) async fn mcp_resources(&self) -> Result<Value> {
        let mut resources = Vec::new();
        for workspace in self.workspaces().await? {
            let id = &workspace.id;
            let mut summaries = self.workspaces.summaries(id, None).await?;
            // Collections, environments and globals, each by name: a stable order.
            let rank = |kind: DocumentKind| match kind {
                DocumentKind::Collection => 0,
                DocumentKind::Environment => 1,
                _ => 2,
            };
            summaries.sort_by_key(|summary| (rank(summary.kind), summary.name.to_lowercase()));
            let mut latest: Option<i64> = None;
            for summary in &summaries {
                let document = encode(summary.id.as_str());
                let (path, description) = match summary.kind {
                    DocumentKind::Collection => (
                        vec!["collections", document.as_str()],
                        "Collection with its requests, without credentials",
                    ),
                    DocumentKind::Environment => (
                        vec!["environments", document.as_str()],
                        "Environment variables, with secret values hidden",
                    ),
                    DocumentKind::Globals => (
                        vec!["globals"],
                        "Global variables, with secret values hidden",
                    ),
                    DocumentKind::History => {
                        latest = latest.max(Some(summary.updated_at));
                        continue;
                    }
                    _ => continue,
                };
                resources.push(json!({
                    "uri": uri(id, &path),
                    "name": format!("{} / {}", workspace.name, summary.name),
                    "title": summary.name,
                    "description": description,
                    "mimeType": JSON,
                }));
            }
            if latest.is_some() {
                resources.push(json!({
                    "uri": uri(id, &["history", "latest"]),
                    "name": format!("{} / Last execution", workspace.name),
                    "title": "Last execution",
                    "description": "The last request sent and its response, without credentials",
                    "mimeType": JSON,
                }));
            }
        }
        Ok(json!({"resources": resources}))
    }

    pub(crate) fn mcp_resource_templates() -> Value {
        json!({"resourceTemplates": [{
            "uriTemplate": format!("{SCHEME}{{workspace}}/collections/{{collection}}/requests/{{request}}"),
            "name": "Request",
            "title": "A request of a collection",
            "description": "One request by its ID or name, without credentials",
            "mimeType": JSON,
        }]})
    }

    /// One resource, as text without secrets.
    pub(crate) async fn mcp_read(&self, uri: &str) -> std::result::Result<Value, Missing> {
        let resource = parse_uri(uri).ok_or(Missing::Resource)?;
        let value = match &resource {
            Resource::Collection(workspace, id) => {
                self.owned(workspace, id, DocumentKind::Collection)
                    .await?
                    .value
            }
            Resource::Request(workspace, id, request) => {
                let collection = self.owned(workspace, id, DocumentKind::Collection).await?;
                find_request(&collection.value["item"], request)
                    .cloned()
                    .ok_or(Missing::Resource)?
            }
            Resource::Environment(workspace, id) => {
                self.owned(workspace, id, DocumentKind::Environment)
                    .await?
                    .value
            }
            Resource::Globals(workspace) => {
                self.documents(workspace, Some(DocumentKind::Globals))
                    .await?
                    .into_iter()
                    .next()
                    .ok_or(Missing::Resource)?
                    .value
            }
            Resource::LastExecution(workspace) => self.last_execution(workspace).await?.value,
        };
        let text = self.redacted(&shareable(&value)).await?;
        Ok(json!({"contents": [{"uri": uri, "mimeType": JSON, "text": text}]}))
    }

    /// A document of a workspace, of the kind asked.
    pub(super) async fn owned(
        &self,
        workspace: &WorkspaceId,
        id: &str,
        kind: DocumentKind,
    ) -> std::result::Result<Document, Missing> {
        let id = nexo_domain::DocumentId::parse(id).map_err(|_| Missing::Resource)?;
        let document = self.document(&id).await?;
        if &document.workspace_id != workspace || document.kind != kind {
            return Err(Missing::Resource);
        }
        Ok(document)
    }
    pub(super) async fn last_execution(
        &self,
        workspace: &WorkspaceId,
    ) -> std::result::Result<Document, Missing> {
        let latest = self
            .summaries(workspace, Some(DocumentKind::History))
            .await?
            .into_iter()
            .max_by_key(|summary| summary.updated_at)
            .ok_or(Missing::Resource)?;
        Ok(self.document(&latest.id).await?)
    }

    /// Pretty JSON with every vault value replaced. Without the vault's list the text is not
    /// shared, since nothing could be checked.
    pub(super) async fn redacted(&self, value: &Value) -> Result<String> {
        let mut text = serde_json::to_string_pretty(value)
            .map_err(|error| Error::Infrastructure(error.to_string()))?;
        for secret in self.secrets.secrets().await? {
            let Ok(secret) = self.secrets.resolve(&secret.name).await else {
                continue;
            };
            if secret.chars().count() < 4 {
                continue;
            }
            let escaped = serde_json::to_string(&secret).unwrap_or_default();
            let escaped = escaped.trim_matches('"').to_string();
            for form in [secret, escaped] {
                if !form.is_empty() {
                    text = text.replace(&form, REDACTED);
                }
            }
        }
        Ok(text)
    }
}
