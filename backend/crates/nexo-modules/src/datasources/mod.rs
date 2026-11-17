//! The databases of the modules as the application sees them: each operation becomes a
//! message of the driver protocol, and each error of a driver a database error with its
//! stable code. Nothing of the protocol leaves this crate.
use crate::Modules;
use async_trait::async_trait;
use nexo_application::ports::{DataSources, SqlConnection, StatementRequest};
use nexo_domain::{Error, Result};
use nexo_driver_sdk::{
    admin::{AdminParams, KillParams, Killed, LockList, SessionList},
    dashboard::{DashboardParams, Dashboards},
    ddl::{DdlModel, DdlModelParams, DdlPlan, DdlPlanParams},
    explain::{ExplainParams, Plan},
    import::{ImportParams, Imported},
    methods,
    protocol::{Ddl, ObjectDescription, ObjectParams, TreeNodes},
    rows::{RowsWriteParams, RowsWritten},
    search::{SearchParams, SearchResult},
    statements::{
        CancelParams, CursorParams, ExecuteParams, ExecuteResult, FetchParams, Page,
        TransactionParams, TransactionState,
    },
};
use serde::Serialize;
use serde_json::{Value, json};
use std::time::Duration;

mod messages;
use messages::{connect_params, database_error, to_json};

impl Modules {
    fn object(session: &str, path: Vec<String>) -> ObjectParams {
        ObjectParams {
            connection: session.to_owned(),
            path,
        }
    }

    /// A request of the application sent to the session's driver as its own message (read,
    /// so a wrong field is refused here, with the session as its connection), and its answer.
    async fn relay<P, R>(
        &self,
        session: &str,
        method: &str,
        mut request: Value,
        what: &str,
    ) -> Result<Value>
    where
        P: serde::de::DeserializeOwned + Serialize + Send + Sync,
        R: serde::de::DeserializeOwned + Serialize,
    {
        request["connection"] = json!(session);
        let params: P = serde_json::from_value(request)
            .map_err(|error| Error::Validation(format!("Invalid {what}: {error}")))?;
        let answer: R = self
            .host()
            .call(session, method, &params)
            .await
            .map_err(database_error)?;
        to_json(answer)
    }
}

#[async_trait]
impl DataSources for Modules {
    async fn driver(&self, driver: &str) -> Result<Value> {
        to_json(self.host().hello(driver).await.map_err(database_error)?)
    }

    async fn test(&self, connection: SqlConnection) -> Result<Value> {
        let session = format!("test-{}", uuid::Uuid::new_v4().simple());
        let (driver, hosts) = (connection.driver.clone(), connection.secret_hosts.clone());
        let params = connect_params(&session, connection)?;
        // Each server the driver asked for, and whether the egress policy let it through.
        let (report, servers) = self.host().test(&driver, params, hosts).await;
        let servers = to_json(servers)?;
        match report {
            Ok(report) => {
                let mut value = to_json(report)?;
                value["servers"] = servers;
                Ok(value)
            }
            Err(error) => {
                let mut detail = error.detail.clone().unwrap_or_else(|| json!({}));
                if let Some(fields) = detail.as_object_mut() {
                    fields.insert("servers".into(), servers);
                }
                Err(database_error(error.with_detail(detail)))
            }
        }
    }

    async fn connect(&self, session: &str, connection: SqlConnection) -> Result<Value> {
        let (driver, hosts) = (connection.driver.clone(), connection.secret_hosts.clone());
        let params = connect_params(session, connection)?;
        let server = self.host().connect(&driver, params, hosts).await;
        to_json(server.map_err(database_error)?)
    }

    async fn disconnect(&self, session: &str) -> Result<()> {
        self.host()
            .disconnect(session)
            .await
            .map_err(database_error)
    }

    async fn tree(&self, session: &str, path: Vec<String>) -> Result<Value> {
        let params = Self::object(session, path);
        let nodes: TreeNodes = self
            .host()
            .call(session, methods::TREE, &params)
            .await
            .map_err(database_error)?;
        to_json(nodes)
    }

    async fn describe(&self, session: &str, path: Vec<String>) -> Result<Value> {
        let params = Self::object(session, path);
        let found: ObjectDescription = self
            .host()
            .call(session, methods::DESCRIBE, &params)
            .await
            .map_err(database_error)?;
        to_json(found)
    }

    async fn ddl(&self, session: &str, path: Vec<String>) -> Result<Value> {
        let params = Self::object(session, path);
        let ddl: Ddl = self
            .host()
            .call(session, methods::DDL, &params)
            .await
            .map_err(database_error)?;
        to_json(ddl)
    }

    async fn execute(&self, session: &str, request: StatementRequest) -> Result<Value> {
        let params = request
            .params
            .into_iter()
            .map(serde_json::from_value)
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|error| {
                Error::Validation(format!("Invalid parameter of the statement: {error}"))
            })?;
        let message = ExecuteParams {
            connection: session.to_owned(),
            statement: request.statement,
            sql: request.sql,
            params,
            page_rows: request.page_rows,
            max_rows: request.max_rows,
        };
        // The driver stops the statement at its limit; the host waits a little longer.
        let limit = request
            .timeout
            .map(|timeout| timeout + Duration::from_secs(5));
        let result: ExecuteResult = self
            .host()
            .call_within(session, methods::EXECUTE, &message, limit)
            .await
            .map_err(database_error)?;
        to_json(result)
    }

    async fn fetch(&self, session: &str, cursor: &str, page_rows: Option<u32>) -> Result<Value> {
        let params = FetchParams {
            connection: session.to_owned(),
            cursor: cursor.to_owned(),
            page_rows,
        };
        let page: Page = self
            .host()
            .call(session, methods::FETCH, &params)
            .await
            .map_err(database_error)?;
        to_json(page)
    }

    async fn close(&self, session: &str, cursor: &str) -> Result<()> {
        let params = CursorParams {
            connection: session.to_owned(),
            cursor: cursor.to_owned(),
        };
        self.host()
            .call(session, methods::CLOSE, &params)
            .await
            .map_err(database_error)
    }

    async fn cancel(&self, session: &str, statement: &str) -> Result<()> {
        let params = CancelParams {
            connection: session.to_owned(),
            statement: statement.to_owned(),
        };
        self.host()
            .call(session, methods::CANCEL, &params)
            .await
            .map_err(database_error)
    }

    async fn transaction(
        &self,
        session: &str,
        action: &str,
        isolation: Option<String>,
    ) -> Result<Value> {
        let action = serde_json::from_value(Value::String(action.to_owned()))
            .map_err(|_| Error::Validation(format!("Unknown transaction action {action}")))?;
        let params = TransactionParams {
            connection: session.to_owned(),
            action,
            isolation,
        };
        let state: TransactionState = self
            .host()
            .call(session, methods::TRANSACTION, &params)
            .await
            .map_err(database_error)?;
        to_json(state)
    }

    async fn write_rows(&self, session: &str, request: Value) -> Result<Value> {
        self.relay::<RowsWriteParams, RowsWritten>(
            session,
            methods::ROWS_WRITE,
            request,
            "change of rows",
        )
        .await
    }

    async fn ddl_model(&self, session: &str, request: Value) -> Result<Value> {
        self.relay::<DdlModelParams, DdlModel>(session, methods::DDL_MODEL, request, "table")
            .await
    }

    async fn ddl_plan(&self, session: &str, request: Value) -> Result<Value> {
        self.relay::<DdlPlanParams, DdlPlan>(
            session,
            methods::DDL_PLAN,
            request,
            "change of structure",
        )
        .await
    }

    async fn search(&self, session: &str, request: Value) -> Result<Value> {
        self.relay::<SearchParams, SearchResult>(session, methods::SEARCH, request, "search")
            .await
    }

    async fn import(&self, session: &str, request: Value) -> Result<Value> {
        self.relay::<ImportParams, Imported>(session, methods::IMPORT, request, "import")
            .await
    }

    async fn explain(&self, session: &str, request: Value) -> Result<Value> {
        self.relay::<ExplainParams, Plan>(session, methods::EXPLAIN, request, "plan request")
            .await
    }

    async fn sessions(&self, session: &str, request: Value) -> Result<Value> {
        self.relay::<AdminParams, SessionList>(session, methods::SESSIONS, request, "request")
            .await
    }

    async fn locks(&self, session: &str, request: Value) -> Result<Value> {
        self.relay::<AdminParams, LockList>(session, methods::LOCKS, request, "request")
            .await
    }

    async fn kill(&self, session: &str, request: Value) -> Result<Value> {
        self.relay::<KillParams, Killed>(
            session,
            methods::KILL,
            request,
            "request to end a session",
        )
        .await
    }

    async fn dashboards(&self, session: &str, request: Value) -> Result<Value> {
        self.relay::<DashboardParams, Dashboards>(session, methods::DASHBOARDS, request, "request")
            .await
    }

    async fn hold(&self, session: &str, held: bool) -> Result<()> {
        self.host().hold(session, held);
        Ok(())
    }
}
