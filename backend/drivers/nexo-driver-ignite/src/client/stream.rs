//! The socket to a node: TCP to the address the host resolved, then TLS on the SDK's rustls
//! configuration (aws-lc-rs) checked against the node's own name. Ignite has no TLS
//! negotiation, so `prefer` tries TLS first and then a plain connection.
use super::{Io, PORT};
use nexo_driver_sdk::{
    DriverError, HostLink, Result, net, protocol::ConnectParams, protocol::TlsMode, tls,
};
use rustls_pki_types::ServerName;
use tokio_rustls::TlsConnector;

/// The node's name, without brackets around an IPv6 address.
pub fn host_of(params: &ConnectParams) -> Result<String> {
    let host = params
        .host
        .as_deref()
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .ok_or_else(|| DriverError::invalid("Write the address of an Ignite node"))?;
    Ok(host.trim_matches(['[', ']']).to_owned())
}

async fn secured(
    host: &HostLink,
    params: &ConnectParams,
    name: &str,
    port: u16,
) -> Result<Box<dyn Io>> {
    let config = tls::client_config(&params.tls)?
        .ok_or_else(|| DriverError::tls("TLS is not set up for this connection"))?;
    let server = ServerName::try_from(name.to_owned())
        .map_err(|error| DriverError::tls(error.to_string()))?;
    let stream = net::connect(host, &params.connection, name, port).await?;
    let secured = TlsConnector::from(config)
        .connect(server, stream)
        .await
        .map_err(|error| DriverError::tls(format!("TLS with {name}:{port} failed: {error}")))?;
    Ok(Box::new(secured))
}

/// The socket and whether it is encrypted.
pub async fn open(host: &HostLink, params: &ConnectParams) -> Result<(Box<dyn Io>, bool)> {
    let name = host_of(params)?;
    let port = params.port.unwrap_or(PORT);
    match params.tls.mode {
        TlsMode::Disable => {
            let stream = net::connect(host, &params.connection, &name, port).await?;
            Ok((Box::new(stream), false))
        }
        TlsMode::Prefer => match secured(host, params, &name, port).await {
            Ok(stream) => Ok((stream, true)),
            Err(error) if error.code == nexo_driver_sdk::ErrorCode::Tls => {
                let stream = net::connect(host, &params.connection, &name, port).await?;
                Ok((Box::new(stream), false))
            }
            Err(error) => Err(error),
        },
        TlsMode::Require | TlsMode::Verify => Ok((secured(host, params, &name, port).await?, true)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_node_is_named_without_brackets() {
        let params = |host: &str| ConnectParams {
            host: Some(host.into()),
            ..ConnectParams::default()
        };
        assert_eq!(host_of(&params(" [::1] ")).unwrap(), "::1");
        assert_eq!(host_of(&params("ignite.local")).unwrap(), "ignite.local");
        assert!(host_of(&params("  ")).is_err());
        assert!(host_of(&ConnectParams::default()).is_err());
    }
}
