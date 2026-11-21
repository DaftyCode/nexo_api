//! «Test the tunnel» of a connection (`db.route.test`, DB-25): its server reached through its
//! SOCKS5 proxy or SSH tunnel without opening a session, so a failure of the way is told
//! apart from one of the database. And the connection a test reads: the one being written
//! in the form, or a saved one.
use super::{redact_error, redact_secrets};
use crate::{Application, payloads::DbRouteTestPayload, ports::DataSources};
use nexo_domain::{Error, Result, WorkspaceId, sql::validate_connection};
use serde_json::{Map, Value};

impl Application {
    /// The connection a test reads: the one being written (`connection`), checked as if it
    /// were saved, or the saved one (`connectionId`) of `workspace`.
    pub(in crate::datasource) async fn tested_connection(
        &self,
        workspace: Option<&WorkspaceId>,
        connection: Option<Map<String, Value>>,
        id: Option<String>,
    ) -> Result<Value> {
        match (connection, id) {
            (Some(connection), _) => {
                let value = Value::Object(connection);
                validate_connection(&value)?;
                Ok(value)
            }
            (None, Some(id)) => {
                let workspace = workspace
                    .cloned()
                    .map_or_else(|| WorkspaceId::parse(""), Ok)?;
                Ok(self.saved_sql_connection(&workspace, &id).await?.value)
            }
            (None, None) => Err(Error::Validation("Choose a connection to test".into())),
        }
    }

    pub(in crate::datasource) async fn test_route(
        &self,
        sources: &dyn DataSources,
        payload: DbRouteTestPayload,
    ) -> Result<Value> {
        let workspace = payload
            .workspace
            .as_deref()
            .map(WorkspaceId::parse)
            .transpose()?;
        let value = self
            .tested_connection(
                workspace.as_ref(),
                payload.connection,
                payload.connection_id,
            )
            .await?;
        let mut values = Vec::new();
        let variables = payload.variables.unwrap_or_default();
        let answer = async {
            let mut connection = self
                .resolve_sql_connection(workspace.as_ref(), &value, &variables, &mut values)
                .await?;
            if connection.route.is_direct() {
                return Err(Error::Validation(
                    "This connection goes straight to its server: choose a SOCKS5 proxy or an SSH tunnel to test it"
                        .into(),
                ));
            }
            if connection.host.is_none() {
                return Err(Error::Validation("Write the server of the connection".into()));
            }
            // The engine's usual port, as the form shows it, when the connection has none.
            connection.port = connection.port.or(payload.port);
            if connection.port.is_none() {
                return Err(Error::Validation("Write the port of the server".into()));
            }
            sources.reach(connection).await
        }
        .await;
        answer
            .map(|value| redact_secrets(value, &values))
            .map_err(|error| redact_error(error, &values))
    }
}
