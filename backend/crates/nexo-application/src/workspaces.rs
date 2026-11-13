//! Workspaces, their documents and the vault's secrets.
use crate::{Application, HISTORY_LIMIT, QUERY_HISTORY_LIMIT, SQL_HISTORY_LIMIT, database};
use nexo_domain::{
    Document, DocumentId, DocumentKind, DocumentSummary, Error, Result, Revision, SecretSummary,
    Workspace, WorkspaceId, hosts::AllowedHosts,
};
use serde_json::Value;

impl Application {
    // Workspaces
    pub async fn workspaces(&self) -> Result<Vec<Workspace>> {
        self.workspaces.workspaces().await
    }
    pub async fn create_workspace(&self, name: &str) -> Result<Workspace> {
        self.workspaces
            .create_workspace(&Workspace::validate_name(name)?)
            .await
    }
    pub async fn rename_workspace(&self, id: &WorkspaceId, name: &str) -> Result<Workspace> {
        self.workspaces
            .rename_workspace(id, &Workspace::validate_name(name)?)
            .await
    }
    pub async fn delete_workspace(&self, id: &WorkspaceId) -> Result<()> {
        let workspaces = self.workspaces.workspaces().await?;
        if !workspaces.iter().any(|w| &w.id == id) {
            return Err(Error::NotFound);
        }
        if workspaces.len() == 1 {
            return Err(Error::Validation(
                "Keep at least one workspace; create another one first".into(),
            ));
        }
        self.workspaces.delete_workspace(id).await
    }
    pub(crate) async fn require_workspace(&self, id: &WorkspaceId) -> Result<()> {
        if self
            .workspaces
            .workspaces()
            .await?
            .iter()
            .any(|w| &w.id == id)
        {
            Ok(())
        } else {
            Err(Error::NotFound)
        }
    }

    // Documents
    pub async fn summaries(
        &self,
        workspace: &WorkspaceId,
        kind: Option<DocumentKind>,
    ) -> Result<Vec<DocumentSummary>> {
        self.require_workspace(workspace).await?;
        self.workspaces.summaries(workspace, kind).await
    }
    pub async fn documents(
        &self,
        workspace: &WorkspaceId,
        kind: Option<DocumentKind>,
    ) -> Result<Vec<Document>> {
        self.require_workspace(workspace).await?;
        self.workspaces.documents(workspace, kind).await
    }
    /// Every document of a workspace, with request history and runs listed without their
    /// values: those grow with use and are loaded one at a time when opened.
    pub async fn listing(&self, workspace: &WorkspaceId) -> Result<Vec<Document>> {
        self.require_workspace(workspace).await?;
        let mut documents = Vec::new();
        for kind in DocumentKind::ALL {
            if kind.listed_whole() {
                documents.extend(self.workspaces.documents(workspace, Some(kind)).await?);
            } else {
                documents.extend(
                    self.workspaces
                        .summaries(workspace, Some(kind))
                        .await?
                        .into_iter()
                        .map(|summary| Document {
                            id: summary.id,
                            workspace_id: summary.workspace_id,
                            kind: summary.kind,
                            name: summary.name,
                            revision: summary.revision,
                            updated_at: summary.updated_at,
                            value: Value::Null,
                        }),
                );
            }
        }
        Ok(documents)
    }
    pub async fn document(&self, id: &DocumentId) -> Result<Document> {
        self.workspaces.document(id).await
    }
    pub async fn save_document(&self, document: Document) -> Result<Document> {
        document.validate()?;
        self.require_workspace(&document.workspace_id).await?;
        let (workspace, kind) = (document.workspace_id.clone(), document.kind);
        let saved = self.workspaces.save(document).await?;
        if kind == DocumentKind::History {
            self.workspaces
                .prune(&workspace, DocumentKind::History, HISTORY_LIMIT)
                .await?;
        }
        if kind == DocumentKind::DatabaseChange {
            self.workspaces
                .prune(
                    &workspace,
                    DocumentKind::DatabaseChange,
                    database::CHANGE_LIMIT,
                )
                .await?;
        }
        if kind == DocumentKind::SqlHistory {
            self.workspaces
                .prune(&workspace, DocumentKind::SqlHistory, SQL_HISTORY_LIMIT)
                .await?;
        }
        if kind == DocumentKind::QueryHistory {
            self.workspaces
                .prune(&workspace, DocumentKind::QueryHistory, QUERY_HISTORY_LIMIT)
                .await?;
        }
        Ok(saved)
    }
    pub async fn delete_document(&self, id: &DocumentId, revision: i64) -> Result<()> {
        self.workspaces.delete(id, revision).await
    }
    pub async fn revisions(&self, id: &DocumentId) -> Result<Vec<Revision>> {
        self.workspaces.revisions(id).await
    }

    // Secrets
    /// Saves a secret's value, its allowed hosts (Postman's "allowed domains"; empty allows
    /// every host) or both. Without a value the stored one is kept.
    pub async fn put_secret(
        &self,
        name: &str,
        value: Option<&str>,
        allowed_hosts: Option<&[String]>,
    ) -> Result<()> {
        if value.is_none() && allowed_hosts.is_none() {
            return Err(Error::Validation(
                "Send a secret value, its allowed domains or both".into(),
            ));
        }
        let hosts = allowed_hosts.map(AllowedHosts::parse).transpose()?;
        self.secrets.put(name, value, hosts.as_ref()).await
    }
    pub async fn remove_secret(&self, name: &str) -> Result<()> {
        self.secrets.remove(name).await
    }
    pub async fn secrets(&self) -> Result<Vec<SecretSummary>> {
        self.secrets.secrets().await
    }
}
