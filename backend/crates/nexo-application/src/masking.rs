//! Data masking: the sets of rules of a workspace (`masking` documents), applied by the
//! engine, which keeps the key of its hashes. A saved set masks an export when the person
//! chooses it; the sets marked for agents mask, always, what MCP agents read.
use crate::{Application, operations::Operation};
use nexo_domain::{
    DocumentId, DocumentKind, Error, Result, WorkspaceId,
    masking::{self, Rules},
};
use serde_json::{Map, Value, json};

impl Application {
    /// `mask.apply`: with the rules of the saved set `set`, or with `rules` not saved yet.
    pub(crate) async fn mask(&self, mut payload: Map<String, Value>) -> Result<Value> {
        let workspace = WorkspaceId::parse(
            payload
                .get("workspace")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )?;
        if let Some(set) = payload.remove("set") {
            let document = self
                .workspaces
                .document(&DocumentId::parse(set.as_str().unwrap_or_default())?)
                .await?;
            if document.kind != DocumentKind::Masking || document.workspace_id != workspace {
                return Err(Error::NotFound);
            }
            payload.insert("rules".into(), document.value["rules"].clone());
        }
        if !payload.contains_key("rules") {
            return Err(Error::Validation("Choose a masking set".into()));
        }
        self.executor
            .execute(Operation::MaskApply, Value::Object(payload))
            .await
    }

    /// The rules of the sets of a workspace marked for agents, one after another; `None`
    /// when there are none.
    pub(crate) async fn agent_rules(&self, workspace: &WorkspaceId) -> Result<Option<Vec<Value>>> {
        let mut rules = Vec::new();
        for document in self
            .workspaces
            .documents(workspace, Some(DocumentKind::Masking))
            .await?
        {
            if masking::for_agents(&document.value) {
                // A set saved before a change of the rules is checked again.
                Rules::read(&document.value)?;
                rules.extend(
                    document.value["rules"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default(),
                );
            }
        }
        Ok((!rules.is_empty()).then_some(rules))
    }

    /// Documents as MCP agents may read them: masked by the sets marked for agents.
    pub(crate) async fn mask_for_agents(
        &self,
        workspace: &WorkspaceId,
        documents: Vec<Value>,
    ) -> Result<Vec<Value>> {
        let Some(rules) = self.agent_rules(workspace).await? else {
            return Ok(documents);
        };
        let masked = self
            .executor
            .execute(
                Operation::MaskApply,
                json!({"workspace": workspace.as_str(), "rules": rules, "documents": documents}),
            )
            .await?;
        Ok(masked["documents"].as_array().cloned().unwrap_or_default())
    }

    /// A response for an MCP agent: its body masked when it is JSON. A body that is not
    /// JSON cannot be masked by field: with sets for agents, it is withheld.
    pub(crate) async fn mask_response_for_agents(
        &self,
        workspace: &WorkspaceId,
        mut response: Value,
    ) -> Result<Value> {
        if self.agent_rules(workspace).await?.is_none() {
            return Ok(response);
        }
        let body = response["body"].as_str().unwrap_or_default().to_string();
        if body.is_empty() {
            return Ok(response);
        }
        response["body"] = match serde_json::from_str::<Value>(&body) {
            Ok(parsed) => {
                let masked = self.mask_for_agents(workspace, vec![parsed]).await?;
                json!(masked.first().map(Value::to_string).unwrap_or_default())
            }
            Err(_) => json!("[withheld: only JSON bodies can be masked]"),
        };
        Ok(response)
    }
}
