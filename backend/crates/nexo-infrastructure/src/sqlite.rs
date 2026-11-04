use crate::{infrastructure as err, now};
use async_trait::async_trait;
use nexo_application::ports::WorkspaceRepository;
use nexo_domain::{
    Document, DocumentId, DocumentKind, DocumentSummary, Error, Result, Revision, Workspace,
    WorkspaceId,
};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde_json::Value;
use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use uuid::Uuid;

/// Number of revisions kept per document; older ones are removed on save.
const REVISIONS_KEPT: i64 = 100;

/// Ordered schema migrations; `PRAGMA user_version` records how many were applied.
const MIGRATIONS: [&str; 3] = [
    "CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,password_hash TEXT NOT NULL);
     CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,name TEXT NOT NULL);
     CREATE TABLE IF NOT EXISTS members(workspace_id TEXT NOT NULL REFERENCES workspaces(id),user_id TEXT NOT NULL REFERENCES users(id),role TEXT NOT NULL,PRIMARY KEY(workspace_id,user_id));
     CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),kind TEXT NOT NULL,name TEXT NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL,value TEXT NOT NULL);
     CREATE INDEX IF NOT EXISTS documents_workspace ON documents(workspace_id,kind,updated_at);
     CREATE TABLE IF NOT EXISTS revisions(document_id TEXT NOT NULL,revision INTEGER NOT NULL,changed_at INTEGER NOT NULL,actor_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(document_id,revision));",
    "ALTER TABLE sessions ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
     CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
     CREATE TABLE IF NOT EXISTS invitations(workspace_id TEXT NOT NULL REFERENCES workspaces(id),email TEXT NOT NULL,role TEXT NOT NULL,invited_at INTEGER NOT NULL,PRIMARY KEY(workspace_id,email));
     DELETE FROM revisions WHERE document_id NOT IN (SELECT id FROM documents);",
    // Nexo is single-user: accounts, sessions and memberships are no longer stored. Every
    // workspace and document is kept.
    "DROP TABLE IF EXISTS invitations;
     DROP TABLE IF EXISTS members;
     DROP TABLE IF EXISTS sessions;
     DROP TABLE IF EXISTS users;",
];

const READERS: usize = 4;

/// One writer connection and a few read-only connections: with WAL, reads run in parallel
/// with each other and with the writer.
pub struct SqliteStore {
    connection: Arc<Mutex<Connection>>,
    readers: Arc<Vec<Mutex<Connection>>>,
    next: Arc<AtomicUsize>,
}
impl SqliteStore {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent).map_err(err)?;
        }
        let mut connection = Connection::open(path).map_err(err)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(err)?;
        connection
            .execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .map_err(err)?;
        Self::migrate(&mut connection)?;
        // An in-memory database is private to its connection, so it has no readers.
        let mut readers = Vec::new();
        if path != Path::new(":memory:") {
            for _ in 0..READERS {
                let reader = Connection::open_with_flags(
                    path,
                    OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
                )
                .map_err(err)?;
                reader
                    .busy_timeout(std::time::Duration::from_secs(5))
                    .map_err(err)?;
                readers.push(Mutex::new(reader));
            }
        }
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
            readers: Arc::new(readers),
            next: Arc::new(AtomicUsize::new(0)),
        })
    }
    fn migrate(connection: &mut Connection) -> Result<()> {
        let applied = connection
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .map_err(err)? as usize;
        if applied > MIGRATIONS.len() {
            return Err(err(
                "The database was created by a newer version of Nexo; update the application",
            ));
        }
        for (index, migration) in MIGRATIONS.iter().enumerate().skip(applied) {
            // Foreign keys are checked per statement; dropping tables in order is safe.
            connection
                .execute_batch("PRAGMA foreign_keys=OFF;")
                .map_err(err)?;
            let transaction = connection.transaction().map_err(err)?;
            transaction.execute_batch(migration).map_err(err)?;
            transaction
                .execute_batch(&format!("PRAGMA user_version={}", index + 1))
                .map_err(err)?;
            transaction.commit().map_err(err)?;
            connection
                .execute_batch("PRAGMA foreign_keys=ON;")
                .map_err(err)?;
        }
        connection
            .execute(
                "INSERT INTO workspaces(id,name) SELECT 'local','My workspace'
                 WHERE NOT EXISTS (SELECT 1 FROM workspaces)",
                [],
            )
            .map_err(err)?;
        Ok(())
    }
    /// Runs a database task on the blocking pool so SQLite never blocks the async runtime.
    async fn with<T, F>(&self, task: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T> + Send + 'static,
    {
        let connection = self.connection.clone();
        tokio::task::spawn_blocking(move || {
            let mut guard = connection.lock().map_err(err)?;
            task(&mut guard)
        })
        .await
        .map_err(err)?
    }
    /// Runs a read-only query on one of the reader connections.
    async fn read<T, F>(&self, task: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> Result<T> + Send + 'static,
    {
        if self.readers.is_empty() {
            return self.with(move |connection| task(connection)).await;
        }
        let (readers, start) = (
            self.readers.clone(),
            self.next.fetch_add(1, Ordering::Relaxed),
        );
        tokio::task::spawn_blocking(move || {
            // Prefer an idle reader; wait for the assigned one otherwise.
            let count = readers.len();
            for offset in 0..count {
                if let Ok(guard) = readers[(start + offset) % count].try_lock() {
                    return task(&guard);
                }
            }
            let guard = readers[start % count].lock().map_err(err)?;
            task(&guard)
        })
        .await
        .map_err(err)?
    }
    fn conversion(error: impl std::error::Error + Send + Sync + 'static) -> rusqlite::Error {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    }
    fn row_document(row: &rusqlite::Row<'_>) -> rusqlite::Result<Document> {
        let value: String = row.get(6)?;
        Ok(Document {
            id: DocumentId::parse(row.get::<_, String>(0)?).map_err(Self::conversion)?,
            workspace_id: WorkspaceId::parse(row.get::<_, String>(1)?).map_err(Self::conversion)?,
            kind: DocumentKind::parse(&row.get::<_, String>(2)?).map_err(Self::conversion)?,
            name: row.get(3)?,
            revision: row.get(4)?,
            updated_at: row.get(5)?,
            value: serde_json::from_str(&value).map_err(Self::conversion)?,
        })
    }
    fn row_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<DocumentSummary> {
        Ok(DocumentSummary {
            id: DocumentId::parse(row.get::<_, String>(0)?).map_err(Self::conversion)?,
            workspace_id: WorkspaceId::parse(row.get::<_, String>(1)?).map_err(Self::conversion)?,
            kind: DocumentKind::parse(&row.get::<_, String>(2)?).map_err(Self::conversion)?,
            name: row.get(3)?,
            revision: row.get(4)?,
            updated_at: row.get(5)?,
        })
    }
    fn row_workspace(row: &rusqlite::Row<'_>) -> rusqlite::Result<Workspace> {
        Ok(Workspace {
            id: WorkspaceId::parse(row.get::<_, String>(0)?).map_err(Self::conversion)?,
            name: row.get(1)?,
        })
    }
}
impl Drop for SqliteStore {
    /// Keeps the database compact when the application closes normally.
    fn drop(&mut self) {
        if Arc::strong_count(&self.connection) == 1
            && let Ok(connection) = self.connection.lock()
        {
            let _ = connection.execute_batch("PRAGMA optimize; PRAGMA wal_checkpoint(TRUNCATE);");
        }
    }
}
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn fixture(id: &str, kind: DocumentKind, revision: i64) -> Document {
        Document {
            id: DocumentId::parse(id).unwrap(),
            workspace_id: WorkspaceId::parse("local").unwrap(),
            kind,
            name: "Fixture".into(),
            revision,
            updated_at: 0,
            value: json!({"item":[]}),
        }
    }
    fn id(value: &str) -> DocumentId {
        DocumentId::parse(value).unwrap()
    }
    #[tokio::test(flavor = "multi_thread")]
    async fn reads_do_not_wait_for_the_writer() {
        let directory = std::env::temp_dir().join(format!("nexo-sqlite-{}", Uuid::new_v4()));
        let store = SqliteStore::open(&directory.join("nexo.sqlite")).unwrap();
        store
            .save(fixture("c1", DocumentKind::Collection, 0))
            .await
            .unwrap();
        let writer = store.connection.clone();
        let held = std::thread::spawn(move || {
            let _guard = writer.lock().unwrap();
            std::thread::sleep(std::time::Duration::from_millis(800));
        });
        std::thread::sleep(std::time::Duration::from_millis(50));
        let started = std::time::Instant::now();
        let target = id("c1");
        let reads = (0..20).map(|_| store.document(&target));
        for read in futures_util::future::join_all(reads).await {
            assert_eq!(read.unwrap().revision, 1);
        }
        assert!(started.elapsed() < std::time::Duration::from_millis(500));
        held.join().unwrap();
        drop(store);
        let _ = std::fs::remove_dir_all(directory);
    }
    #[tokio::test]
    async fn revisions_are_atomic() {
        let store = SqliteStore::open(Path::new(":memory:")).unwrap();
        let saved = store
            .save(fixture("fixture", DocumentKind::Collection, 0))
            .await
            .unwrap();
        assert_eq!(saved.revision, 1);
        assert!(matches!(
            store
                .save(fixture("fixture", DocumentKind::Collection, 0))
                .await,
            Err(Error::Conflict)
        ));
        assert!(matches!(
            store.document(&id("missing")).await,
            Err(Error::NotFound)
        ));
        assert_eq!(store.revisions(&id("fixture")).await.unwrap().len(), 1);
    }
    #[tokio::test]
    async fn deleted_documents_can_be_recreated_without_old_revisions() {
        let store = SqliteStore::open(Path::new(":memory:")).unwrap();
        store
            .save(fixture("again", DocumentKind::Collection, 0))
            .await
            .unwrap();
        store
            .save(fixture("again", DocumentKind::Collection, 1))
            .await
            .unwrap();
        store.delete(&id("again"), 2).await.unwrap();
        let recreated = store
            .save(fixture("again", DocumentKind::Collection, 0))
            .await
            .unwrap();
        assert_eq!(recreated.revision, 1);
        assert_eq!(store.revisions(&id("again")).await.unwrap().len(), 1);
    }
    #[tokio::test]
    async fn summaries_omit_values_and_history_is_pruned() {
        let store = SqliteStore::open(Path::new(":memory:")).unwrap();
        let local = WorkspaceId::parse("local").unwrap();
        for index in 0..5 {
            store
                .save(fixture(&format!("h{index}"), DocumentKind::History, 0))
                .await
                .unwrap();
        }
        assert_eq!(
            store
                .summaries(&local, Some(DocumentKind::History))
                .await
                .unwrap()
                .len(),
            5
        );
        assert_eq!(
            store.prune(&local, DocumentKind::History, 2).await.unwrap(),
            3
        );
        assert_eq!(store.summaries(&local, None).await.unwrap().len(), 2);
    }
    #[tokio::test]
    async fn workspaces_can_be_renamed_and_deleted_with_their_documents() {
        let store = SqliteStore::open(Path::new(":memory:")).unwrap();
        let other = store.create_workspace("Work").await.unwrap();
        let mut document = fixture("w1", DocumentKind::Collection, 0);
        document.workspace_id = other.id.clone();
        store.save(document).await.unwrap();
        assert_eq!(
            store.rename_workspace(&other.id, "Job").await.unwrap().name,
            "Job"
        );
        store.delete_workspace(&other.id).await.unwrap();
        assert!(matches!(
            store.document(&id("w1")).await,
            Err(Error::NotFound)
        ));
        assert_eq!(store.workspaces().await.unwrap().len(), 1);
    }
    #[tokio::test]
    async fn multi_user_databases_migrate_to_a_single_user() {
        let directory = std::env::temp_dir().join(format!("nexo-migrate-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("nexo.sqlite");
        {
            let mut connection = Connection::open(&path).unwrap();
            for migration in &MIGRATIONS[..2] {
                connection.execute_batch(migration).unwrap();
            }
            connection
                .execute_batch(
                    "PRAGMA user_version=2;
                     INSERT INTO users VALUES('u','a@b.c','A','hash');
                     INSERT INTO workspaces VALUES('w','Team');
                     INSERT INTO members VALUES('w','u','owner');
                     INSERT INTO documents VALUES('d','w','collection','C',1,0,'{\"item\":[]}');",
                )
                .unwrap();
            let _ = &mut connection;
        }
        let store = SqliteStore::open(&path).unwrap();
        assert_eq!(store.workspaces().await.unwrap()[0].name, "Team");
        assert_eq!(store.document(&id("d")).await.unwrap().name, "C");
        let tables: i64 = store
            .with(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('users','members','sessions')",
                    [],
                    |r| r.get(0),
                )
                .map_err(err)
            })
            .await
            .unwrap();
        assert_eq!(tables, 0);
        drop(store);
        let _ = std::fs::remove_dir_all(directory);
    }
}
