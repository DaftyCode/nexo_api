mod repository;

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

#[cfg(test)]
mod tests;
