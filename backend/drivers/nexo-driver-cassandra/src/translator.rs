//! Every node the driver discovers goes through the host before it is connected to: a node
//! the egress policy refuses is never reached.
//!
//! A node announces the address it has inside its network (`rpc_address`), which from this
//! computer may not be reachable: a Cassandra in Docker announces the container's. The Java
//! driver uses the address it connected to for the node it asked; the Rust driver does not,
//! so when a node does not answer at its own address and there is one contact point, it is
//! reached at the contact point, and the log says so.
use async_trait::async_trait;
use nexo_driver_sdk::HostLink;
use scylla::{
    errors::TranslationError,
    policies::address_translator::{AddressTranslator, UntranslatedPeer},
};
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::Duration,
};

/// How long a node has to accept a connection at its own address.
const PROBE: Duration = Duration::from_millis(1500);

pub(crate) struct HostTranslator {
    link: HostLink,
    connection: String,
    /// The contact points, as the host resolved and allowed them.
    contacts: Vec<SocketAddr>,
    /// What each node's address became, so that a refresh of the metadata asks again only
    /// for new nodes.
    known: Mutex<HashMap<SocketAddr, SocketAddr>>,
}

impl HostTranslator {
    pub(crate) fn new(link: HostLink, connection: String, contacts: Vec<SocketAddr>) -> Arc<Self> {
        Arc::new(Self {
            link,
            connection,
            contacts,
            known: Mutex::new(HashMap::new()),
        })
    }

    async fn allowed(&self, address: SocketAddr) -> bool {
        self.link
            .resolve(&self.connection, &address.ip().to_string(), address.port())
            .await
            .unwrap_or_default()
            .contains(&address)
    }

    async fn reachable(address: SocketAddr) -> bool {
        matches!(
            tokio::time::timeout(PROBE, tokio::net::TcpStream::connect(address)).await,
            Ok(Ok(_))
        )
    }

    /// Where a node is reached, once the host has allowed its address.
    async fn route(&self, address: SocketAddr) -> SocketAddr {
        if self.contacts.contains(&address) || Self::reachable(address).await {
            return address;
        }
        match self.contacts.as_slice() {
            [contact] => {
                self.link
                    .log(
                        "warn",
                        format!(
                            "Node {address} cannot be reached at the address it announces: \
                             using the contact point {contact} (for a cluster, set \
                             broadcast_rpc_address on its nodes)"
                        ),
                    )
                    .await;
                *contact
            }
            _ => address,
        }
    }
}

#[async_trait]
impl AddressTranslator for HostTranslator {
    async fn translate_address(
        &self,
        peer: &UntranslatedPeer,
    ) -> std::result::Result<SocketAddr, TranslationError> {
        let address = peer.untranslated_address();
        if let Some(known) = self.known.lock().unwrap().get(&address) {
            return Ok(*known);
        }
        if !self.allowed(address).await {
            self.link
                .log(
                    "warn",
                    format!("Node {address} not allowed by the egress policy"),
                )
                .await;
            return Err(TranslationError::NoRuleForAddress(address));
        }
        let routed = self.route(address).await;
        self.known.lock().unwrap().insert(address, routed);
        Ok(routed)
    }
}
