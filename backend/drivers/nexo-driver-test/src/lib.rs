//! A database driver that keeps everything in memory, to test the host of the driver
//! processes and the SDK without a database server. It is never published.
//!
//! Its statements are in [`statements`]. A connection needs the password `secret`. Options
//! of a connection, for the tests of the host:
//! - `leak=log`: writes the password to the standard error (which the host must mask);
//! - `leak=error`: refuses the connection with an error that carries the password;
//! - a `host` and a `port`: asks the host of the process whether it may connect there.
mod statements;

use async_trait::async_trait;
use nexo_driver_sdk::{
    Driver, DriverError, HostLink, PROTOCOL_VERSION, Result, Value,
    protocol::{
        Capabilities, ConnectParams, Ddl, Dialect, DriverInfo, Hello, ObjectDescription,
        ObjectParams, ParameterStyle, Property, Section, ServerInfo, TreeNode,
    },
    statements::{
        CancelParams, CursorParams, ExecuteParams, ExecuteResult, FetchParams, Page,
        TransactionAction, TransactionParams, TransactionState,
    },
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::Notify;

/// One connection: its table of people, the copy a transaction would go back to, and the
/// cursors left open.
#[derive(Default)]
struct Session {
    people: Vec<String>,
    before: Option<Vec<String>>,
    manual: bool,
    cursors: HashMap<String, statements::Cursor>,
    opened: u64,
}

#[derive(Default)]
pub struct TestDriver {
    sessions: Mutex<HashMap<String, Session>>,
    /// Statements that are waiting, by connection and name, to cancel them.
    running: Mutex<HashMap<(String, String), Arc<Notify>>>,
}

fn unknown_connection() -> DriverError {
    DriverError::invalid("The connection is not open")
}

impl TestDriver {
    fn session<T>(
        &self,
        connection: &str,
        action: impl FnOnce(&mut Session) -> Result<T>,
    ) -> Result<T> {
        let mut sessions = self.sessions.lock().unwrap();
        action(
            sessions
                .get_mut(connection)
                .ok_or_else(unknown_connection)?,
        )
    }
}

#[async_trait]
impl Driver for TestDriver {
    fn hello(&self) -> Hello {
        Hello {
            protocol: PROTOCOL_VERSION,
            driver: DriverInfo {
                id: "test".into(),
                name: "Test".into(),
                version: env!("CARGO_PKG_VERSION").into(),
            },
            capabilities: Capabilities {
                transactions: true,
                cancel: true,
                ..Capabilities::default()
            },
            dialect: Dialect {
                name: "test".into(),
                quote_open: "\"".into(),
                quote_close: "\"".into(),
                parameters: ParameterStyle::Question,
                keywords: vec!["select".into(), "insert".into()],
                ..Dialect::default()
            },
        }
    }

    async fn connect(&self, host: &HostLink, params: ConnectParams) -> Result<ServerInfo> {
        let password = params.password.clone().unwrap_or_default();
        match params.options.get("leak").map(String::as_str) {
            Some("log") => eprintln!("connecting with password {password}"),
            Some("error") => {
                return Err(
                    DriverError::auth(format!("The password {password} was refused"))
                        .with_detail(serde_json::json!({"password": password})),
                );
            }
            _ => {}
        }
        if password != "secret" {
            return Err(DriverError::auth("Password authentication failed"));
        }
        if let (Some(name), Some(port)) = (&params.host, params.port) {
            host.resolve(&params.connection, name, port).await?;
        }
        let mut sessions = self.sessions.lock().unwrap();
        if sessions.contains_key(&params.connection) {
            return Err(DriverError::invalid("The connection is already open"));
        }
        let session = Session {
            people: vec!["Ada".into(), "Grace".into()],
            ..Session::default()
        };
        sessions.insert(params.connection, session);
        Ok(ServerInfo {
            server_version: "1.0".into(),
            database: params.database,
            user: params.user,
            ..ServerInfo::default()
        })
    }

    async fn disconnect(&self, connection: &str) -> Result<()> {
        let closed = self.sessions.lock().unwrap().remove(connection);
        closed.map(|_| ()).ok_or_else(unknown_connection)
    }

    async fn tree(&self, params: ObjectParams) -> Result<Vec<TreeNode>> {
        self.session(&params.connection, |_| Ok(()))?;
        let node = |kind: &str, name: &str, detail: Option<&str>| TreeNode {
            kind: kind.into(),
            name: name.into(),
            label: name.into(),
            detail: detail.map(Into::into),
            has_children: kind == "table",
            actions: vec!["open".into()],
            system: false,
        };
        match params.path.as_slice() {
            [] => Ok(vec![
                node("table", "numbers", None),
                node("table", "people", None),
            ]),
            [table] if table == "numbers" => Ok(vec![
                node("column", "n", Some("integer")),
                node("column", "label", Some("text")),
            ]),
            [table] if table == "people" => Ok(vec![node("column", "name", Some("text"))]),
            _ => Err(DriverError::invalid("There is no such object")),
        }
    }

    async fn describe(&self, params: ObjectParams) -> Result<ObjectDescription> {
        let columns = self.tree(params.clone()).await?;
        Ok(ObjectDescription {
            kind: "table".into(),
            name: params.path.join("."),
            properties: vec![Property {
                name: "columns".into(),
                value: Value::Integer(columns.len() as i64),
            }],
            sections: vec![Section {
                id: "columns".into(),
                title: "Columns".into(),
                columns: vec!["name".into(), "type".into()],
                rows: columns
                    .into_iter()
                    .map(|column| {
                        let kind = column.detail.unwrap_or_default();
                        vec![Value::Text(column.name), Value::Text(kind)]
                    })
                    .collect(),
            }],
        })
    }

    async fn ddl(&self, params: ObjectParams) -> Result<Ddl> {
        let description = self.describe(params).await?;
        Ok(Ddl {
            sql: format!("create table {} (…)", description.name),
        })
    }

    async fn execute(&self, params: ExecuteParams) -> Result<ExecuteResult> {
        statements::execute(self, params).await
    }

    async fn fetch(&self, params: FetchParams) -> Result<Page> {
        self.session(&params.connection, |session| {
            statements::fetch(session, &params.cursor, params.page_rows)
        })
    }

    async fn close(&self, params: CursorParams) -> Result<()> {
        self.session(&params.connection, |session| {
            let closed = session.cursors.remove(&params.cursor);
            closed
                .map(|_| ())
                .ok_or_else(|| DriverError::invalid("The cursor is not open"))
        })
    }

    async fn cancel(&self, params: CancelParams) -> Result<()> {
        let key = (params.connection, params.statement);
        if let Some(waiting) = self.running.lock().unwrap().get(&key) {
            waiting.notify_one();
        }
        Ok(())
    }

    async fn transaction(&self, params: TransactionParams) -> Result<TransactionState> {
        self.session(&params.connection, |session| {
            match params.action {
                TransactionAction::Status => {}
                TransactionAction::Begin => {
                    session.before.get_or_insert_with(|| session.people.clone());
                }
                TransactionAction::Commit => session.before = None,
                TransactionAction::Rollback => {
                    if let Some(before) = session.before.take() {
                        session.people = before;
                    }
                }
                TransactionAction::Auto => session.manual = false,
                TransactionAction::Manual => session.manual = true,
            }
            Ok(TransactionState {
                auto_commit: !session.manual,
                open: session.before.is_some(),
            })
        })
    }
}
