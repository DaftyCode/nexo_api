//! The databases of the modules as the application sees them: each operation becomes a
//! message of the driver protocol, and each error of a driver a database error with its
//! stable code. Nothing of the protocol leaves this crate.
use crate::Modules;
use async_trait::async_trait;
use nexo_application::ports::{DataSources, SqlConnection, StatementRequest};
use nexo_domain::{Error, Result};
use nexo_driver_sdk::{
    DriverError, methods,
    protocol::{ConnectParams, Ddl, ObjectDescription, ObjectParams, TlsSettings, TreeNodes},
    statements::{
        CancelParams, CursorParams, ExecuteParams, ExecuteResult, FetchParams, Page,
        TransactionParams, TransactionState,
    },
};
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

/// A driver's error as the application answers it: `database.<code>` with its detail.
fn database_error(error: DriverError) -> Error {
    let code = serde_json::to_value(error.code)
        .ok()
        .and_then(|code| code.as_str().map(String::from))
        .unwrap_or_else(|| "internal".into());
    Error::Database {
        code,
        message: error.message,
        detail: error.detail,
    }
}

fn to_json(value: impl Serialize) -> Result<Value> {
    serde_json::to_value(value).map_err(|error| Error::Infrastructure(error.to_string()))
}

/// The settings of a connection as its driver reads them.
fn connect_params(session: &str, connection: SqlConnection) -> Result<ConnectParams> {
    let mode =
        serde_json::from_value(Value::String(connection.tls.mode.clone())).map_err(|_| {
            Error::Validation(format!(
                "Unknown TLS mode {}: use disable, prefer, require or verify",
                connection.tls.mode
            ))
        })?;
    Ok(ConnectParams {
        connection: session.to_owned(),
        host: connection.host,
        port: connection.port,
        database: connection.database,
        user: connection.user,
        password: connection.password,
        tls: TlsSettings {
            mode,
            ca_pem: connection.tls.ca_pem,
            cert_pem: connection.tls.cert_pem,
            key_pem: connection.tls.key_pem,
        },
        options: connection.options,
        read_only: connection.read_only,
    })
}

impl Modules {
    fn object(session: &str, path: Vec<String>) -> ObjectParams {
        ObjectParams {
            connection: session.to_owned(),
            path,
        }
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
        let report = self.host().test(&driver, params, hosts).await;
        to_json(report.map_err(database_error)?)
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
}
