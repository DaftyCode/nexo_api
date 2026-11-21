//! «Test the tunnel» (DB-25): the server of a connection reached through its route, as the
//! driver would reach it, without the driver.
use crate::Modules;
use nexo_application::ports::SqlConnection;
use nexo_domain::{Error, Result};
use serde_json::{Value, json};
use std::time::Instant;

impl Modules {
    pub(super) async fn reach_server(&self, connection: SqlConnection) -> Result<Value> {
        let (Some(host), Some(port)) = (connection.host.clone(), connection.port) else {
            return Err(Error::Validation(
                "Write the server and the port of the connection".into(),
            ));
        };
        let started = Instant::now();
        let forward = self.host().forward(&connection.route, &host, port).await?;
        let ms = started.elapsed().as_millis() as u64;
        drop(forward);
        Ok(json!({
            "host": host,
            "port": port,
            "via": connection.route.route["via"],
            "ms": ms,
        }))
    }
}
