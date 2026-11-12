//! The `WorkspaceRepository` port: workspaces, documents, their revisions and pruning.
use super::*;

#[async_trait]
impl WorkspaceRepository for SqliteStore {
    async fn workspaces(&self) -> Result<Vec<Workspace>> {
        self.read(|connection| {
            let mut query = connection
                .prepare("SELECT id,name FROM workspaces ORDER BY name COLLATE NOCASE")
                .map_err(err)?;
            query
                .query_map([], Self::row_workspace)
                .map_err(err)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(err)
        })
        .await
    }
    async fn create_workspace(&self, name: &str) -> Result<Workspace> {
        let name = name.to_string();
        self.with(move |connection| {
            let id = WorkspaceId::parse(Uuid::new_v4().to_string())?;
            connection
                .execute(
                    "INSERT INTO workspaces(id,name) VALUES(?1,?2)",
                    params![id.as_str(), name],
                )
                .map_err(err)?;
            Ok(Workspace { id, name })
        })
        .await
    }
    async fn rename_workspace(&self, id: &WorkspaceId, name: &str) -> Result<Workspace> {
        let (id, name) = (id.clone(), name.to_string());
        self.with(move |connection| {
            let changed = connection
                .execute(
                    "UPDATE workspaces SET name=?2 WHERE id=?1",
                    params![id.as_str(), name],
                )
                .map_err(err)?;
            if changed == 0 {
                return Err(Error::NotFound);
            }
            Ok(Workspace { id, name })
        })
        .await
    }
    async fn delete_workspace(&self, id: &WorkspaceId) -> Result<()> {
        let id = id.clone();
        self.with(move |connection| {
            let tx = connection.transaction().map_err(err)?;
            tx.execute(
                "DELETE FROM revisions WHERE document_id IN (SELECT id FROM documents WHERE workspace_id=?1)",
                [id.as_str()],
            )
            .map_err(err)?;
            tx.execute("DELETE FROM documents WHERE workspace_id=?1", [id.as_str()])
                .map_err(err)?;
            if tx
                .execute("DELETE FROM workspaces WHERE id=?1", [id.as_str()])
                .map_err(err)?
                == 0
            {
                return Err(Error::NotFound);
            }
            tx.commit().map_err(err)
        })
        .await
    }
    async fn summaries(
        &self,
        workspace: &WorkspaceId,
        kind: Option<DocumentKind>,
    ) -> Result<Vec<DocumentSummary>> {
        let (workspace, kind) = (workspace.clone(), kind.map(|k| k.as_str()));
        self.read(move |connection| {
            let mut query = connection
                .prepare(
                    "SELECT id,workspace_id,kind,name,revision,updated_at FROM documents
                     WHERE workspace_id=?1 AND (?2 IS NULL OR kind=?2) ORDER BY updated_at DESC,id",
                )
                .map_err(err)?;
            query
                .query_map(params![workspace.as_str(), kind], Self::row_summary)
                .map_err(err)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(err)
        })
        .await
    }
    async fn documents(
        &self,
        workspace: &WorkspaceId,
        kind: Option<DocumentKind>,
    ) -> Result<Vec<Document>> {
        let (workspace, kind) = (workspace.clone(), kind.map(|k| k.as_str()));
        self.read(move |connection| {
            let mut query = connection
                .prepare(
                    "SELECT id,workspace_id,kind,name,revision,updated_at,value FROM documents
                     WHERE workspace_id=?1 AND (?2 IS NULL OR kind=?2) ORDER BY updated_at DESC,id",
                )
                .map_err(err)?;
            query
                .query_map(params![workspace.as_str(), kind], Self::row_document)
                .map_err(err)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(err)
        })
        .await
    }
    async fn document(&self, id: &DocumentId) -> Result<Document> {
        let id = id.clone();
        self.read(move |connection| {
            connection
                .query_row(
                    "SELECT id,workspace_id,kind,name,revision,updated_at,value FROM documents WHERE id=?1",
                    [id.as_str()],
                    Self::row_document,
                )
                .optional()
                .map_err(err)?
                .ok_or(Error::NotFound)
        })
        .await
    }
    async fn save(&self, mut document: Document) -> Result<Document> {
        self.with(move |connection| {
            let tx = connection.transaction().map_err(err)?;
            let current: Option<(String, i64)> = tx
                .query_row(
                    "SELECT workspace_id,revision FROM documents WHERE id=?1",
                    [document.id.as_str()],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(err)?;
            if let Some((workspace, revision)) = &current {
                if workspace != document.workspace_id.as_str() || *revision != document.revision {
                    return Err(Error::Conflict);
                }
            } else if document.revision != 0 {
                return Err(Error::Conflict);
            }
            document.revision += 1;
            document.updated_at = now();
            tx.execute(
                "INSERT INTO documents VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET
                 name=excluded.name,kind=excluded.kind,revision=excluded.revision,
                 updated_at=excluded.updated_at,value=excluded.value",
                params![
                    document.id.as_str(),
                    document.workspace_id.as_str(),
                    document.kind.as_str(),
                    document.name,
                    document.revision,
                    document.updated_at,
                    document.value.to_string()
                ],
            )
            .map_err(err)?;
            if document.kind.keeps_revisions() {
                tx.execute(
                    "INSERT OR REPLACE INTO revisions VALUES(?1,?2,?3,'local',?4)",
                    params![
                        document.id.as_str(),
                        document.revision,
                        document.updated_at,
                        serde_json::to_string(&document).map_err(err)?
                    ],
                )
                .map_err(err)?;
                tx.execute(
                    "DELETE FROM revisions WHERE document_id=?1 AND revision<=?2",
                    params![document.id.as_str(), document.revision - REVISIONS_KEPT],
                )
                .map_err(err)?;
            }
            tx.commit().map_err(err)?;
            Ok(document)
        })
        .await
    }
    async fn delete(&self, id: &DocumentId, revision: i64) -> Result<()> {
        let id = id.clone();
        self.with(move |connection| {
            let tx = connection.transaction().map_err(err)?;
            let current: i64 = tx
                .query_row(
                    "SELECT revision FROM documents WHERE id=?1",
                    [id.as_str()],
                    |r| r.get(0),
                )
                .optional()
                .map_err(err)?
                .ok_or(Error::NotFound)?;
            if revision != current {
                return Err(Error::Conflict);
            }
            tx.execute("DELETE FROM documents WHERE id=?1", [id.as_str()])
                .map_err(err)?;
            // Deleting a document also removes its history, including any values it contained.
            tx.execute("DELETE FROM revisions WHERE document_id=?1", [id.as_str()])
                .map_err(err)?;
            tx.commit().map_err(err)
        })
        .await
    }
    async fn revisions(&self, id: &DocumentId) -> Result<Vec<Revision>> {
        self.document(id).await?;
        let id = id.clone();
        self.read(move |connection| {
            let mut query = connection
                .prepare(
                    "SELECT revision,changed_at,value FROM revisions WHERE document_id=?1
                     ORDER BY revision DESC LIMIT 100",
                )
                .map_err(err)?;
            query
                .query_map([id.as_str()], |r| {
                    let s: String = r.get(2)?;
                    Ok(Revision {
                        revision: r.get(0)?,
                        changed_at: r.get(1)?,
                        value: serde_json::from_str(&s).unwrap_or(Value::Null),
                    })
                })
                .map_err(err)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(err)
        })
        .await
    }
    async fn prune(
        &self,
        workspace: &WorkspaceId,
        kind: DocumentKind,
        keep: usize,
    ) -> Result<usize> {
        let workspace = workspace.clone();
        self.with(move |connection| {
            let tx = connection.transaction().map_err(err)?;
            let removed = tx
                .execute(
                    "DELETE FROM documents WHERE id IN (
                       SELECT id FROM documents WHERE workspace_id=?1 AND kind=?2
                       ORDER BY updated_at DESC, id DESC LIMIT -1 OFFSET ?3)",
                    params![workspace.as_str(), kind.as_str(), keep as i64],
                )
                .map_err(err)?;
            tx.execute(
                "DELETE FROM revisions WHERE document_id NOT IN (SELECT id FROM documents)",
                [],
            )
            .map_err(err)?;
            tx.commit().map_err(err)?;
            Ok(removed)
        })
        .await
    }
}
