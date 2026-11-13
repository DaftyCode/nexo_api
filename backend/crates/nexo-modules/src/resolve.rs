//! What the host answers a driver: the addresses it may connect to, and its log lines.
use crate::{connections::Connections, host::LogSink, redact::Secrets};
use async_trait::async_trait;
use nexo_application::ports::NetworkPolicy;
use nexo_driver_sdk::{
    DriverError, Handler, Result, methods,
    protocol::{LogParams, NetResolveParams, NetResolved},
};
use serde_json::{Value, json};
use std::sync::Arc;

pub(crate) struct Answers {
    pub module: String,
    pub network: Arc<dyn NetworkPolicy>,
    pub connections: Arc<Connections>,
    pub secrets: Arc<Secrets>,
    pub log: LogSink,
}

#[async_trait]
impl Handler for Answers {
    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        if method != methods::NET_RESOLVE {
            return Err(DriverError::unsupported(format!(
                "The host does not answer {method}"
            )));
        }
        let params: NetResolveParams = serde_json::from_value(params)
            .map_err(|error| DriverError::invalid(format!("Invalid request: {error}")))?;
        // Only for a connection this driver was asked to open: a driver cannot use the
        // host to look at the network on its own.
        let secret_hosts = self
            .connections
            .secret_hosts(&params.connection, &self.module)
            .ok_or_else(|| DriverError::invalid("Unknown connection"))?;
        for (secret, hosts) in &secret_hosts {
            if !hosts.allows(&params.host) {
                return Err(DriverError::network(format!(
                    "The secret {secret} may not be sent to {}: it is not among its allowed domains",
                    params.host
                )));
            }
        }
        let addresses = self
            .network
            .resolve_destination(&params.host, params.port)
            .await
            .map_err(|error| DriverError::network(error.to_string()))?;
        Ok(json!(NetResolved {
            addresses: addresses.iter().map(ToString::to_string).collect(),
        }))
    }

    async fn notification(&self, method: &str, params: Value) {
        if method != methods::LOG {
            return;
        }
        if let Ok(line) = serde_json::from_value::<LogParams>(params) {
            (self.log)(&self.module, &line.level, &self.secrets.text(&line.message));
        }
    }
}
