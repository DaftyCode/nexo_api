//! MongoDB adapter: implements the application's document database port with the official
//! driver. Nothing outside this crate depends on `mongodb`; `nexo-server` composes it.
//!
//! The design (dependencies, egress policy, certificates, limits, redaction) is written in
//! `docs/ARCHITECTURE.md`, section "MongoDB".
use mongodb::options::ClientOptions;
use std::time::Duration;

/// Limits of every connection, so the interface and the engine stay responsive.
pub mod limits {
    use std::time::Duration;
    /// How long to wait for a server to answer before giving up on it.
    pub const SERVER_SELECTION: Duration = Duration::from_secs(10);
    /// How long to wait to open a connection.
    pub const CONNECT: Duration = Duration::from_secs(10);
    /// How long one operation may run before it is cancelled (`maxTimeMS`).
    pub const OPERATION: Duration = Duration::from_secs(60);
    /// Documents in a page of results.
    pub const PAGE_DOCUMENTS: u64 = 1_000;
    /// Bytes of results sent to the interface at once.
    pub const RESPONSE_BYTES: usize = 16 * 1024 * 1024;
    /// Connections per server: one person, a few panels.
    pub const POOL: u32 = 4;
}

/// The options every connection starts from; the URI and the person's settings come on top.
pub fn base_options() -> ClientOptions {
    let mut options = ClientOptions::default();
    options.app_name = Some("Nexo API".into());
    options.server_selection_timeout = Some(limits::SERVER_SELECTION);
    options.connect_timeout = Some(limits::CONNECT);
    options.max_pool_size = Some(limits::POOL);
    options.max_idle_time = Some(Duration::from_secs(300));
    options
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn options_parse_a_uri_without_a_network() {
        let parsed = ClientOptions::parse("mongodb://localhost:27017/?directConnection=true")
            .await
            .unwrap();
        assert_eq!(parsed.direct_connection, Some(true));
        let base = base_options();
        assert_eq!(base.app_name.as_deref(), Some("Nexo API"));
        assert_eq!(base.max_pool_size, Some(limits::POOL));
    }

    /// The driver builds its TLS settings from rustls' default aws-lc-rs provider: it must
    /// prefer the post-quantum key exchange, as every other connection of Nexo does.
    #[test]
    fn tls_prefers_post_quantum_key_exchange() {
        let provider = rustls::crypto::aws_lc_rs::default_provider();
        assert_eq!(
            provider.kx_groups[0].name(),
            rustls::NamedGroup::X25519MLKEM768
        );
    }
}
