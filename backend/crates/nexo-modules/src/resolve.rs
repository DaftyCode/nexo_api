//! What the host answers a driver: the addresses it may connect to, and its log lines.
use crate::{
    connections::{Connections, Destination},
    host::LogSink,
    redact::Secrets,
};
use async_trait::async_trait;
use nexo_application::ports::{ConnectionRoute, NetworkPolicy};
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

impl Answers {
    /// The loopback port that reaches the server through the connection's route: the one
    /// already open for it, or a new one (the server is reached once through the route now).
    async fn forward(
        &self,
        params: &NetResolveParams,
        route: &ConnectionRoute,
    ) -> std::result::Result<std::net::SocketAddr, String> {
        let (connection, host, port) = (&params.connection, &params.host, params.port);
        if let Some(address) = self.connections.forwarded(connection, host, port) {
            return Ok(address);
        }
        let forward = self
            .network
            .forward(route, host, port)
            .await
            .map_err(|error| error.to_string())?;
        Ok(self
            .connections
            .keep_forward(connection, host, port, forward))
    }
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
        let (secret_hosts, route) = self
            .connections
            .secret_hosts(&params.connection, &self.module)
            .ok_or_else(|| DriverError::invalid("Unknown connection"))?;
        let refused = |reason: String| {
            self.connections.record(
                &params.connection,
                Destination {
                    host: params.host.clone(),
                    port: params.port,
                    allowed: false,
                    addresses: Vec::new(),
                    reason: Some(reason.clone()),
                },
            );
            DriverError::network(reason)
        };
        for (secret, hosts) in &secret_hosts {
            if !hosts.allows(&params.host) {
                return Err(refused(format!(
                    "The secret {secret} may not be sent to {}: it is not among its allowed domains",
                    params.host
                )));
            }
        }
        let addresses: Vec<String> = if route.is_direct() {
            self.network
                .resolve_destination(&params.host, params.port)
                .await
                .map_err(|error| refused(error.to_string()))?
                .iter()
                .map(ToString::to_string)
                .collect()
        } else {
            // Through its proxy or tunnel: a loopback port the host relays from.
            vec![
                self.forward(&params, &route)
                    .await
                    .map_err(refused)?
                    .to_string(),
            ]
        };
        self.connections.record(
            &params.connection,
            Destination {
                host: params.host.clone(),
                port: params.port,
                allowed: true,
                addresses: addresses.clone(),
                reason: None,
            },
        );
        Ok(json!(NetResolved { addresses }))
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
