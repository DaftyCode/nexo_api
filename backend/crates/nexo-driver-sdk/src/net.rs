//! Connecting to a database server through the host's egress policy.
use crate::{DriverError, HostLink, Result, limits};
use tokio::net::TcpStream;

/// Opens a TCP connection to `host`, at one of the addresses the host allows. The name is
/// kept by the caller for TLS (SNI and certificate check): only the address comes from the
/// host, so what was checked is what is connected to.
pub async fn connect(
    link: &HostLink,
    connection: &str,
    host: &str,
    port: u16,
) -> Result<TcpStream> {
    let addresses = link.resolve(connection, host, port).await?;
    let mut last = None;
    for address in addresses {
        match tokio::time::timeout(limits::CONNECT, TcpStream::connect(address)).await {
            Ok(Ok(stream)) => {
                // Statements and their answers are small messages: do not wait to group them.
                let _ = stream.set_nodelay(true);
                return Ok(stream);
            }
            Ok(Err(error)) => last = Some(format!("Cannot connect to {host}:{port}: {error}")),
            Err(_) => last = Some(format!("{host}:{port} did not answer in time")),
        }
    }
    Err(DriverError::network(
        last.unwrap_or_else(|| format!("{host} has no address")),
    ))
}
