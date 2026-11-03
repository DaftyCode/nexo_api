use crate::{infrastructure as err, now};
use argon2::{
    Argon2,
    password_hash::{PasswordHasher, PasswordVerifier, phc::PasswordHash},
};
use async_trait::async_trait;
use nexo_application::ports::{IdentityProvider, WorkspaceRepository};
use nexo_domain::{Actor, Credentials, Document, Error, Result, Revision, Session, Workspace};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Mutex};
use uuid::Uuid;

pub struct SqliteStore {
    connection: Mutex<Connection>,
}
impl SqliteStore {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent).map_err(err)?;
        }
        let connection = Connection::open(path).map_err(err)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(err)?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,password_hash TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,name TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS members(workspace_id TEXT NOT NULL REFERENCES workspaces(id),user_id TEXT NOT NULL REFERENCES users(id),role TEXT NOT NULL,PRIMARY KEY(workspace_id,user_id));
            CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),kind TEXT NOT NULL,name TEXT NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL,value TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS documents_workspace ON documents(workspace_id,kind,updated_at);
            CREATE TABLE IF NOT EXISTS revisions(document_id TEXT NOT NULL,revision INTEGER NOT NULL,changed_at INTEGER NOT NULL,actor_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(document_id,revision));
            INSERT OR IGNORE INTO users VALUES('local','','Local workspace','');
            INSERT OR IGNORE INTO workspaces VALUES('local','My workspace');
            INSERT OR IGNORE INTO members VALUES('local','local','owner');").map_err(err)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>> {
        self.connection.lock().map_err(err)
    }
    fn authorize(
        connection: &Connection,
        actor: &Actor,
        workspace: &str,
        write: bool,
        owner: bool,
    ) -> Result<()> {
        let role: Option<String> = connection
            .query_row(
                "SELECT role FROM members WHERE workspace_id=?1 AND user_id=?2",
                params![workspace, actor.id],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?;
        match role.as_deref() {
            Some("owner") => Ok(()),
            Some("editor") if !owner => Ok(()),
            Some("viewer") if !owner && !write => Ok(()),
            _ => Err(Error::Forbidden),
        }
    }
    fn row_document(row: &rusqlite::Row<'_>) -> rusqlite::Result<Document> {
        let value: String = row.get(6)?;
        Ok(Document {
            id: row.get(0)?,
            workspace_id: row.get(1)?,
            kind: row.get(2)?,
            name: row.get(3)?,
            revision: row.get(4)?,
            updated_at: row.get(5)?,
            value: serde_json::from_str(&value).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    6,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })?,
        })
    }
    fn session(connection: &Connection, actor: Actor) -> Result<Session> {
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let expires_at = now() + 60 * 60 * 24 * 7;
        connection
            .execute("DELETE FROM sessions WHERE expires_at<?1", [now()])
            .map_err(err)?;
        connection
            .execute(
                "INSERT INTO sessions VALUES(?1,?2,?3)",
                params![
                    hex::encode(Sha256::digest(token.as_bytes())),
                    actor.id,
                    expires_at
                ],
            )
            .map_err(err)?;
        Ok(Session {
            token,
            actor,
            expires_at,
        })
    }
}
#[async_trait]
impl WorkspaceRepository for SqliteStore {
    async fn workspaces(&self, actor: &Actor) -> Result<Vec<Workspace>> {
        let connection = self.lock()?;
        let mut query=connection.prepare("SELECT w.id,w.name,m.role FROM workspaces w JOIN members m ON m.workspace_id=w.id WHERE m.user_id=?1 ORDER BY w.name").map_err(err)?;
        query
            .query_map([&actor.id], |r| {
                Ok(Workspace {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    role: r.get(2)?,
                })
            })
            .map_err(err)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)
    }
    async fn create_workspace(&self, actor: &Actor, name: &str) -> Result<Workspace> {
        if name.trim().is_empty() || name.len() > 200 {
            return Err(Error::Validation("Workspace name is required".into()));
        }
        let mut connection = self.lock()?;
        let transaction = connection.transaction().map_err(err)?;
        let id = Uuid::new_v4().to_string();
        transaction
            .execute(
                "INSERT INTO workspaces VALUES(?1,?2)",
                params![id, name.trim()],
            )
            .map_err(err)?;
        transaction
            .execute(
                "INSERT INTO members VALUES(?1,?2,'owner')",
                params![id, actor.id],
            )
            .map_err(err)?;
        transaction.commit().map_err(err)?;
        Ok(Workspace {
            id,
            name: name.trim().into(),
            role: "owner".into(),
        })
    }
    async fn members(&self, actor: &Actor, workspace: &str) -> Result<Value> {
        let connection = self.lock()?;
        Self::authorize(&connection, actor, workspace, false, false)?;
        let mut query=connection.prepare("SELECT u.id,u.email,u.name,m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=?1").map_err(err)?;
        let rows=query.query_map([workspace],|r|Ok(json!({"id":r.get::<_,String>(0)?,"email":r.get::<_,String>(1)?,"name":r.get::<_,String>(2)?,"role":r.get::<_,String>(3)?}))).map_err(err)?.collect::<std::result::Result<Vec<_>,_>>().map_err(err)?;
        Ok(json!(rows))
    }
    async fn add_member(
        &self,
        actor: &Actor,
        workspace: &str,
        email: &str,
        role: &str,
    ) -> Result<()> {
        if !["editor", "viewer", "remove"].contains(&role) {
            return Err(Error::Validation(
                "Role must be editor, viewer or remove".into(),
            ));
        }
        let connection = self.lock()?;
        Self::authorize(&connection, actor, workspace, true, true)?;
        let user: String = connection
            .query_row(
                "SELECT id FROM users WHERE email=?1",
                [email.trim().to_lowercase()],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?
            .ok_or(Error::NotFound)?;
        if user == actor.id {
            return Err(Error::Validation(
                "Owner membership cannot be changed here".into(),
            ));
        }
        if role == "remove" {
            connection
                .execute(
                    "DELETE FROM members WHERE workspace_id=?1 AND user_id=?2",
                    params![workspace, user],
                )
                .map_err(err)?;
        } else {
            connection.execute("INSERT INTO members VALUES(?1,?2,?3) ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role",params![workspace,user,role]).map_err(err)?;
        }
        Ok(())
    }
    async fn documents(
        &self,
        actor: &Actor,
        workspace: &str,
        kind: Option<&str>,
    ) -> Result<Vec<Document>> {
        let connection = self.lock()?;
        Self::authorize(&connection, actor, workspace, false, false)?;
        let mut query=connection.prepare("SELECT id,workspace_id,kind,name,revision,updated_at,value FROM documents WHERE workspace_id=?1 AND (?2 IS NULL OR kind=?2) ORDER BY updated_at DESC,id").map_err(err)?;
        query
            .query_map(params![workspace, kind], Self::row_document)
            .map_err(err)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)
    }
    async fn document(&self, actor: &Actor, id: &str) -> Result<Document> {
        let connection = self.lock()?;
        let doc=connection.query_row("SELECT id,workspace_id,kind,name,revision,updated_at,value FROM documents WHERE id=?1",[id],Self::row_document).optional().map_err(err)?.ok_or(Error::NotFound)?;
        Self::authorize(&connection, actor, &doc.workspace_id, false, false)?;
        Ok(doc)
    }
    async fn save(&self, actor: &Actor, mut document: Document) -> Result<Document> {
        let mut connection = self.lock()?;
        let tx = connection.transaction().map_err(err)?;
        Self::authorize(&tx, actor, &document.workspace_id, true, false)?;
        let current: Option<(String, i64)> = tx
            .query_row(
                "SELECT workspace_id,revision FROM documents WHERE id=?1",
                [&document.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(err)?;
        if let Some((workspace, revision)) = &current {
            if workspace != &document.workspace_id {
                return Err(Error::Forbidden);
            }
            if *revision != document.revision {
                return Err(Error::Conflict);
            }
        } else if document.revision != 0 {
            return Err(Error::Conflict);
        }
        document.revision += 1;
        document.updated_at = now();
        tx.execute("INSERT INTO documents VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,revision=excluded.revision,updated_at=excluded.updated_at,value=excluded.value",params![document.id,document.workspace_id,document.kind,document.name,document.revision,document.updated_at,document.value.to_string()]).map_err(err)?;
        tx.execute(
            "INSERT INTO revisions VALUES(?1,?2,?3,?4,?5)",
            params![
                document.id,
                document.revision,
                document.updated_at,
                actor.id,
                serde_json::to_string(&document).map_err(err)?
            ],
        )
        .map_err(err)?;
        tx.commit().map_err(err)?;
        Ok(document)
    }
    async fn delete(&self, actor: &Actor, id: &str, revision: i64) -> Result<()> {
        let mut connection = self.lock()?;
        let tx = connection.transaction().map_err(err)?;
        let (workspace, current): (String, i64) = tx
            .query_row(
                "SELECT workspace_id,revision FROM documents WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(err)?
            .ok_or(Error::NotFound)?;
        Self::authorize(&tx, actor, &workspace, true, false)?;
        if revision != current {
            return Err(Error::Conflict);
        }
        tx.execute("DELETE FROM documents WHERE id=?1", [id])
            .map_err(err)?;
        tx.commit().map_err(err)?;
        Ok(())
    }
    async fn revisions(&self, actor: &Actor, id: &str) -> Result<Vec<Revision>> {
        self.document(actor, id).await?;
        let connection = self.lock()?;
        let mut query=connection.prepare("SELECT revision,changed_at,actor_id,value FROM revisions WHERE document_id=?1 ORDER BY revision DESC LIMIT 100").map_err(err)?;
        query
            .query_map([id], |r| {
                let s: String = r.get(3)?;
                Ok(Revision {
                    revision: r.get(0)?,
                    changed_at: r.get(1)?,
                    actor_id: r.get(2)?,
                    value: serde_json::from_str(&s).unwrap_or(Value::Null),
                })
            })
            .map_err(err)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)
    }
}
#[async_trait]
impl IdentityProvider for SqliteStore {
    async fn has_users(&self) -> Result<bool> {
        Ok(self
            .lock()?
            .query_row("SELECT COUNT(*) FROM users WHERE id!='local'", [], |r| {
                r.get::<_, i64>(0)
            })
            .map_err(err)?
            > 0)
    }
    async fn register(&self, credentials: Credentials, allow_signup: bool) -> Result<Session> {
        credentials.validate()?;
        let password = credentials.password.clone();
        let hash = tokio::task::spawn_blocking(move || {
            Argon2::default()
                .hash_password_with_salt(password.as_bytes(), Uuid::new_v4().as_bytes())
                .map(|x| x.to_string())
                .map_err(err)
        })
        .await
        .map_err(err)??;
        let mut connection = self.lock()?;
        let tx = connection.transaction().map_err(err)?;
        let count: i64 = tx
            .query_row("SELECT COUNT(*) FROM users WHERE id!='local'", [], |r| {
                r.get(0)
            })
            .map_err(err)?;
        if count > 0 && !allow_signup {
            return Err(Error::Forbidden);
        }
        let actor = Actor {
            id: Uuid::new_v4().to_string(),
            email: credentials.email.trim().to_lowercase(),
            name: if credentials.name.trim().is_empty() {
                credentials.email.clone()
            } else {
                credentials.name.trim().into()
            },
        };
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM users WHERE email=?1)",
                [&actor.email],
                |r| r.get(0),
            )
            .map_err(err)?;
        if exists {
            return Err(Error::Validation(
                "This email already has an account".into(),
            ));
        }
        tx.execute(
            "INSERT INTO users VALUES(?1,?2,?3,?4)",
            params![actor.id, actor.email, actor.name, hash],
        )
        .map_err(err)?;
        let workspace = Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO workspaces VALUES(?1,'My workspace')",
            [&workspace],
        )
        .map_err(err)?;
        tx.execute(
            "INSERT INTO members VALUES(?1,?2,'owner')",
            params![workspace, actor.id],
        )
        .map_err(err)?;
        let session = Self::session(&tx, actor)?;
        tx.commit().map_err(err)?;
        Ok(session)
    }
    async fn login(&self, credentials: Credentials) -> Result<Session> {
        let record: Option<(Actor, String)> = {
            let connection = self.lock()?;
            connection
                .query_row(
                    "SELECT id,email,name,password_hash FROM users WHERE email=?1 AND id!='local'",
                    [credentials.email.trim().to_lowercase()],
                    |r| {
                        Ok((
                            Actor {
                                id: r.get(0)?,
                                email: r.get(1)?,
                                name: r.get(2)?,
                            },
                            r.get(3)?,
                        ))
                    },
                )
                .optional()
                .map_err(err)?
        };
        let (actor, hash) = record.ok_or(Error::Unauthorized)?;
        let valid = tokio::task::spawn_blocking(move || {
            PasswordHash::new(&hash).ok().is_some_and(|h| {
                Argon2::default()
                    .verify_password(credentials.password.as_bytes(), &h)
                    .is_ok()
            })
        })
        .await
        .map_err(err)?;
        if !valid {
            return Err(Error::Unauthorized);
        }
        Self::session(&*self.lock()?, actor)
    }
    async fn resolve(&self, token: &str) -> Result<Actor> {
        let connection = self.lock()?;
        connection.query_row("SELECT u.id,u.email,u.name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?1 AND s.expires_at>?2",params![hex::encode(Sha256::digest(token.as_bytes())),now()],|r|Ok(Actor{id:r.get(0)?,email:r.get(1)?,name:r.get(2)?})).optional().map_err(err)?.ok_or(Error::Unauthorized)
    }
    async fn logout(&self, token: &str) -> Result<()> {
        self.lock()?
            .execute(
                "DELETE FROM sessions WHERE token_hash=?1",
                [hex::encode(Sha256::digest(token.as_bytes()))],
            )
            .map_err(err)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn revisions_are_atomic_and_workspace_scoped() {
        let store = SqliteStore::open(Path::new(":memory:")).unwrap();
        let actor = Actor::local();
        let document = Document {
            id: "fixture".into(),
            workspace_id: "local".into(),
            kind: "collection".into(),
            name: "Fixture".into(),
            revision: 0,
            updated_at: 0,
            value: json!({"item":[]}),
        };
        let saved = store.save(&actor, document.clone()).await.unwrap();
        assert_eq!(saved.revision, 1);
        assert!(matches!(
            store.save(&actor, document).await,
            Err(Error::Conflict)
        ));
        let outsider = Actor {
            id: "outsider".into(),
            email: "x@y.test".into(),
            name: "Other".into(),
        };
        assert!(matches!(
            store.document(&outsider, "fixture").await,
            Err(Error::Forbidden)
        ));
        assert_eq!(store.revisions(&actor, "fixture").await.unwrap().len(), 1);
    }
}
