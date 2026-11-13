//! The transaction of a connection, and cancelling a statement through another connection.
use crate::{connection::PgConnection, errors::database};
use nexo_driver_sdk::{
    DriverError, Result, net,
    statements::{TransactionAction, TransactionState},
};
use tokio_postgres::NoTls;

const ISOLATIONS: [&str; 4] = [
    "read uncommitted",
    "read committed",
    "repeatable read",
    "serializable",
];

impl PgConnection {
    /// Cancels the statement if it is running, through another connection to the server.
    pub async fn cancel(&self, statement: &str) -> Result<()> {
        if !self.running.lock().unwrap().contains(statement) {
            return Ok(());
        }
        let host = self.params.host.clone().unwrap_or_default();
        let port = self.params.port.unwrap_or(5432);
        let stream = net::connect(&self.link, &self.params.connection, &host, port).await?;
        let cancelled = match &self.main.tls {
            None => self.main.cancel.cancel_query_raw(stream, NoTls).await,
            Some(tls) => self.main.cancel.cancel_query_raw(stream, tls.clone()).await,
        };
        cancelled.map_err(|error| database(error, None))
    }

    pub async fn transaction(
        &self,
        action: TransactionAction,
        isolation: Option<&str>,
    ) -> Result<TransactionState> {
        let client = &self.main.client;
        let run = |sql: String| async move {
            client
                .batch_execute(&sql)
                .await
                .map_err(|error| database(error, None))
        };
        let open = self.state.lock().unwrap().open;
        match action {
            TransactionAction::Status => {}
            TransactionAction::Begin if !open => {
                let level = match isolation.map(str::to_ascii_lowercase) {
                    None => String::new(),
                    Some(level) if ISOLATIONS.contains(&level.as_str()) => {
                        format!(" ISOLATION LEVEL {level}")
                    }
                    Some(level) => {
                        return Err(DriverError::invalid(format!(
                            "PostgreSQL has no isolation level {level}"
                        )));
                    }
                };
                run(format!("BEGIN{level}")).await?;
                self.state.lock().unwrap().open = true;
            }
            TransactionAction::Begin => {}
            TransactionAction::Commit | TransactionAction::Rollback | TransactionAction::Auto => {
                if open {
                    let word = if action == TransactionAction::Rollback {
                        "ROLLBACK"
                    } else {
                        "COMMIT"
                    };
                    run(word.into()).await?;
                }
                let mut state = self.state.lock().unwrap();
                state.open = false;
                if action == TransactionAction::Auto {
                    state.auto = true;
                }
            }
            TransactionAction::Manual => self.state.lock().unwrap().auto = false,
        }
        let state = *self.state.lock().unwrap();
        Ok(TransactionState {
            auto_commit: state.auto,
            open: state.open,
        })
    }
}
