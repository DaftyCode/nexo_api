//! Protected environments. The interface names the active environment (`environment`, its
//! document id); when that environment is read-only the engine gets its name in
//! `readOnlyEnvironment` and refuses every request that may change data, scripts included.
//! Only environments of the payload's workspace count, and clients cannot set the name.
use crate::Application;
use nexo_domain::{DocumentId, DocumentKind, Result, WorkspaceId};
use serde_json::Value;

impl Application {
    /// The name of environment `id` of `workspace` when its protection is `readonly`.
    pub(crate) async fn read_only_environment(
        &self,
        workspace: Option<&str>,
        id: Option<&Value>,
    ) -> Result<Option<String>> {
        let (Some(workspace), Some(id)) = (workspace, id.and_then(Value::as_str)) else {
            return Ok(None);
        };
        let (Ok(workspace), Ok(id)) = (WorkspaceId::parse(workspace), DocumentId::parse(id)) else {
            return Ok(None);
        };
        // An environment deleted meanwhile protects nothing any more.
        let Ok(document) = self.workspaces.document(&id).await else {
            return Ok(None);
        };
        if document.kind != DocumentKind::Environment
            || document.workspace_id != workspace
            || document.value["protection"] != "readonly"
        {
            return Ok(None);
        }
        Ok(Some(document.name))
    }
}

#[cfg(test)]
mod tests {
    use crate::testing::*;

    fn environment(id: &str, workspace: &str, value: Value) -> Document {
        Document {
            id: DocumentId::parse(id).unwrap(),
            workspace_id: WorkspaceId::parse(workspace).unwrap(),
            kind: DocumentKind::Environment,
            name: format!("Env {id}"),
            revision: 1,
            updated_at: 0,
            value,
        }
    }

    #[tokio::test]
    async fn the_engine_learns_the_read_only_environment_and_nothing_a_client_sends() {
        let (application, fake) = application();
        fake.documents.lock().unwrap().extend([
            environment(
                "prod",
                "local",
                json!({"values": [], "protection": "readonly"}),
            ),
            environment(
                "stage",
                "local",
                json!({"values": [], "protection": "confirm"}),
            ),
            environment(
                "other",
                "elsewhere",
                json!({"values": [], "protection": "readonly"}),
            ),
        ]);
        let request = |environment: &str| {
            json!({"workspace": "local", "environment": environment,
                "readOnlyEnvironment": "forged", "request": {"url": "https://api.test"}})
        };
        for (environment, expected) in [
            ("prod", json!("Env prod")),
            ("stage", Value::Null),
            ("other", Value::Null),
            ("gone", Value::Null),
        ] {
            application
                .execute(Operation::Request, request(environment))
                .await
                .unwrap();
            let (_, sent) = fake.executed.lock().unwrap().pop().unwrap();
            assert_eq!(sent["readOnlyEnvironment"], expected, "{environment}");
        }
        application
            .execute(
                Operation::Run,
                json!({"workspace": "local", "environment": "prod", "collection": {"item": []}}),
            )
            .await
            .unwrap();
        let (_, sent) = fake.executed.lock().unwrap().pop().unwrap();
        assert_eq!(sent["readOnlyEnvironment"], "Env prod");
    }
}
