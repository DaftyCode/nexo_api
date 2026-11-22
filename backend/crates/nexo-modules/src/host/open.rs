//! What an adapter that keeps its own connections asks the host: whether one is still open,
//! and the egress policy its driver's connections go through.
use super::DriverHost;
use nexo_application::ports::NetworkPolicy;
use std::sync::Arc;

impl DriverHost {
    /// Whether a connection is open in a driver that still runs: the host closes the ones
    /// unused for a while, and those of a driver that stopped.
    pub async fn is_open(&self, connection: &str) -> bool {
        let Some((module, generation)) = self.shared.connections.peek(connection) else {
            return false;
        };
        let processes = self.shared.processes.lock().await;
        processes
            .get(&module)
            .is_some_and(|process| process.alive() && process.generation == generation)
    }

    /// The egress policy the connections of the drivers go through.
    pub fn network(&self) -> Arc<dyn NetworkPolicy> {
        self.shared.network.clone()
    }
}
