use super::*;
use crate::{
    Driver, ErrorCode, HostLink, ValueKind,
    protocol::{
        Capabilities, ConnectParams, Dialect, DriverInfo, Hello, ObjectParams, ServerInfo, TreeNode,
    },
    statements::{CursorParams, ExecuteParams, ExecuteResult, FetchParams, Page},
};
use async_trait::async_trait;
use std::sync::Mutex;

/// Answers each query of [`Catalog`] by its name, and fails the ones named in `failing`.
#[derive(Default)]
struct Fake {
    asked: Mutex<Vec<String>>,
    failing: Vec<&'static str>,
    lacking: bool,
}
#[async_trait]
impl Driver for Fake {
    fn hello(&self) -> Hello {
        Hello {
            protocol: 1,
            driver: DriverInfo {
                id: "fake".into(),
                name: "Fake".into(),
                version: "1".into(),
            },
            capabilities: Capabilities::default(),
            dialect: Dialect::default(),
        }
    }
    async fn connect(&self, _: &HostLink, _: ConnectParams) -> Result<ServerInfo> {
        Ok(ServerInfo::default())
    }
    async fn disconnect(&self, _: &str) -> Result<()> {
        Ok(())
    }
    async fn tree(&self, _: ObjectParams) -> Result<Vec<TreeNode>> {
        Ok(Vec::new())
    }
    async fn execute(&self, params: ExecuteParams) -> Result<ExecuteResult> {
        self.asked.lock().unwrap().push(params.sql.clone());
        if self.failing.contains(&params.sql.as_str()) {
            return Err(DriverError::new(ErrorCode::Permission, "denied"));
        }
        let text = |value: &str| Value::Text(value.into());
        let rows = match params.sql.as_str() {
            "privilege" if self.lacking => vec![vec![text("pg_monitor")]],
            "privilege" => vec![vec![Value::Null]],
            "own" => vec![vec![Value::Integer(7)]],
            "sessions" => vec![
                vec![
                    Value::Integer(7),
                    text("ana"),
                    text("shop"),
                    text("Nexo"),
                    text("10.0.0.1:5000"),
                    text("active"),
                    Value::Typed {
                        kind: ValueKind::Decimal,
                        text: "1.5".into(),
                        full_size: None,
                    },
                    Value::Null,
                    text("SELECT 1"),
                    Value::Bool(true),
                    Value::Bool(true),
                ],
                vec![
                    text("8"),
                    text(""),
                    Value::Null,
                    Value::Null,
                    Value::Null,
                    text("Sleep"),
                    Value::Integer(30),
                    text("Lock: relation"),
                    Value::Null,
                    Value::Integer(0),
                    text("f"),
                ],
                vec![Value::Null],
            ],
            "locks" => vec![
                vec![
                    text("9"),
                    text("8"),
                    text("public.orders"),
                    text("RowExclusiveLock"),
                    Value::Float(2.0),
                    text("ana"),
                    text("UPDATE orders"),
                    text("eva"),
                    text("UPDATE orders"),
                ],
                vec![text("9"), Value::Null],
            ],
            "cancel 8" => vec![vec![Value::Bool(false)]],
            _ => Vec::new(),
        };
        Ok(ExecuteResult {
            rows,
            cursor: (params.sql == "locks").then(|| "c1".into()),
            ..ExecuteResult::default()
        })
    }
    async fn fetch(&self, _: FetchParams) -> Result<Page> {
        Ok(Page::default())
    }
    async fn close(&self, params: CursorParams) -> Result<()> {
        self.asked
            .lock()
            .unwrap()
            .push(format!("close {}", params.cursor));
        Ok(())
    }
}

struct Catalog;
impl AdminCatalog for Catalog {
    fn sessions(&self) -> String {
        "sessions".into()
    }
    fn locks(&self) -> String {
        "locks".into()
    }
    fn privilege(&self) -> String {
        "privilege".into()
    }
    fn own(&self) -> String {
        "own".into()
    }
    fn kill(&self, id: &str, mode: KillMode) -> Result<AdminQuery> {
        let id = numeric_id(id)?;
        match mode {
            KillMode::Cancel => Ok(AdminQuery {
                sql: format!("cancel {id}"),
                params: Vec::new(),
            }),
            KillMode::Terminate => Err(DriverError::unsupported("no ending")),
        }
    }
}

fn asking() -> AdminParams {
    AdminParams {
        connection: "tree:c1".into(),
        statement: "admin-1".into(),
    }
}
fn killing(session: &str, mode: KillMode) -> KillParams {
    KillParams {
        connection: "tree:c1".into(),
        statement: "admin-2".into(),
        session: session.into(),
        mode,
    }
}

#[tokio::test]
async fn sessions_are_read_in_the_same_shape_for_every_engine() {
    let driver = Fake::default();
    let list = sessions(&driver, asking(), &Catalog).await.unwrap();
    assert_eq!(list.privilege, None);
    assert_eq!(list.sessions.len(), 2);
    let own = &list.sessions[0];
    assert_eq!(own.id, "7");
    assert_eq!(own.client.as_deref(), Some("10.0.0.1:5000"));
    assert_eq!(own.seconds, Some(1.5));
    assert!(own.own && own.active);
    let other = &list.sessions[1];
    assert_eq!((other.user.clone(), other.seconds), (None, Some(30.0)));
    assert_eq!(other.wait.as_deref(), Some("Lock: relation"));
    assert!(!other.own && !other.active);
    let json = serde_json::to_value(&list).unwrap();
    assert!(json.get("privilege").is_none());
    assert!(json["sessions"][1].get("own").is_none());
}

#[tokio::test]
async fn without_the_privilege_the_view_says_which_one_is_missing() {
    let driver = Fake {
        lacking: true,
        failing: vec!["locks"],
        ..Fake::default()
    };
    let list = sessions(&driver, asking(), &Catalog).await.unwrap();
    assert_eq!(list.privilege.as_deref(), Some("pg_monitor"));
    assert_eq!(list.sessions.len(), 2);
    let locks = locks(&driver, asking(), &Catalog).await.unwrap();
    assert_eq!(
        (locks.waits.len(), locks.privilege.as_deref()),
        (0, Some("pg_monitor"))
    );

    let denied = Fake {
        failing: vec!["sessions", "privilege"],
        ..Fake::default()
    };
    let error = super::sessions(&denied, asking(), &Catalog)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Permission);
}

#[tokio::test]
async fn waits_say_who_waits_for_whom_and_the_cursor_is_closed() {
    let driver = Fake::default();
    let list = locks(&driver, asking(), &Catalog).await.unwrap();
    assert_eq!(list.waits.len(), 1);
    let wait = &list.waits[0];
    assert_eq!((wait.waiting.as_str(), wait.blocking.as_str()), ("9", "8"));
    assert_eq!(wait.object.as_deref(), Some("public.orders"));
    assert_eq!(wait.seconds, Some(2.0));
    assert_eq!(wait.blocking_user.as_deref(), Some("eva"));
    assert!(
        driver
            .asked
            .lock()
            .unwrap()
            .contains(&"close c1".to_string())
    );
}

#[tokio::test]
async fn the_own_session_is_never_ended_and_ids_are_numbers() {
    let driver = Fake::default();
    let own = kill(&driver, killing(" 7 ", KillMode::Cancel), &Catalog).await;
    assert!(own.unwrap_err().message.contains("Nexo's own session"));
    let gone = kill(&driver, killing("8", KillMode::Cancel), &Catalog).await;
    assert_eq!(gone.unwrap(), Killed { done: false });
    let done = kill(&driver, killing("12", KillMode::Cancel), &Catalog).await;
    assert_eq!(done.unwrap(), Killed { done: true });
    let unsupported = kill(&driver, killing("12", KillMode::Terminate), &Catalog).await;
    assert_eq!(unsupported.unwrap_err().code, ErrorCode::Unsupported);
    for wrong in ["1; DROP TABLE t", "-3", "0", ""] {
        let refused = kill(&driver, killing(wrong, KillMode::Cancel), &Catalog).await;
        assert_eq!(refused.unwrap_err().code, ErrorCode::Invalid, "{wrong}");
    }
    let asked = driver.asked.lock().unwrap();
    assert!(!asked.iter().any(|sql| sql.contains("DROP")));
}

#[test]
fn modes_and_answers_travel_in_lower_case() {
    assert_eq!(
        serde_json::to_value(KillMode::Terminate).unwrap(),
        "terminate"
    );
    let params: KillParams = serde_json::from_value(serde_json::json!({
        "connection": "c", "statement": "s", "session": "42", "mode": "cancel"
    }))
    .unwrap();
    assert_eq!(params.mode, KillMode::Cancel);
    assert_eq!(
        serde_json::to_value(Killed { done: true }).unwrap(),
        serde_json::json!({"done": true})
    );
}
