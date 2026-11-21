//! Loopback ports forwarded through a route, for database drivers (DB-25): a driver connects
//! to an address, never through a proxy, so the host gives it `127.0.0.1:port` and each
//! connection made there is relayed to the destination through the route's SOCKS5 proxy or
//! SSH tunnel, as `ssh -L` does. The destination is reached once when the port opens, so a
//! refusal or a server that cannot be reached is said at once and not as a closed socket.
use super::Dialer;
use nexo_domain::{Error, Result};
use std::net::{Ipv4Addr, SocketAddr};
use tokio::{
    net::{TcpListener, TcpStream},
    task::{AbortHandle, JoinSet},
};

/// Connections relayed at once through one forwarded port, at most: a driver opens a few
/// (a session, the cancel of a statement), never hundreds.
const RELAYS: usize = 64;

/// An open forwarded port; dropping it closes the port and every relayed connection.
pub struct Forward {
    pub address: SocketAddr,
    task: AbortHandle,
}
impl Drop for Forward {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Opens a loopback port that relays to `host:port` through `dialer`'s route.
pub async fn open(dialer: Dialer, host: String, port: u16) -> Result<Forward> {
    // The first connection is made now: its errors are the ones worth reading.
    let first = dialer.connect(&host, port).await?;
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|error| Error::Infrastructure(format!("No local port to forward: {error}")))?;
    let address = listener
        .local_addr()
        .map_err(|error| Error::Infrastructure(error.to_string()))?;
    let task = tokio::spawn(serve(listener, dialer, host, port, first)).abort_handle();
    Ok(Forward { address, task })
}

async fn serve(listener: TcpListener, dialer: Dialer, host: String, port: u16, first: TcpStream) {
    let mut first = Some(first);
    // Aborting this task drops the set, which aborts every relay with it.
    let mut relays = JoinSet::new();
    loop {
        let Ok((mut inbound, _)) = listener.accept().await else {
            return;
        };
        while relays.try_join_next().is_some() {}
        if relays.len() >= RELAYS {
            continue;
        }
        let _ = inbound.set_nodelay(true);
        let ready = first.take();
        let (dialer, host) = (dialer.clone(), host.clone());
        relays.spawn(async move {
            let outbound = match ready {
                Some(stream) => Ok(stream),
                None => dialer.connect(&host, port).await,
            };
            if let Ok(mut outbound) = outbound {
                let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{egress::Policy, route::Route};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// A server that answers each connection with what it read, upper-cased.
    async fn upper() -> SocketAddr {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buffer = [0; 64];
                    let read = socket.read(&mut buffer).await.unwrap_or(0);
                    let _ = socket.write_all(&buffer[..read].to_ascii_uppercase()).await;
                });
            }
        });
        address
    }

    async fn round_trip(address: SocketAddr, text: &str) -> String {
        let mut stream = TcpStream::connect(address).await.unwrap();
        stream.write_all(text.as_bytes()).await.unwrap();
        let mut answer = String::new();
        stream.read_to_string(&mut answer).await.unwrap();
        answer
    }

    #[tokio::test]
    async fn every_connection_to_the_port_reaches_the_destination_until_it_is_dropped() {
        let server = upper().await;
        let dialer = Dialer::new(Route::Direct, Policy::AllowAll, Vec::new());
        let forward = open(dialer, server.ip().to_string(), server.port())
            .await
            .unwrap();
        assert!(forward.address.ip().is_loopback());
        assert_ne!(forward.address.port(), server.port());
        assert_eq!(round_trip(forward.address, "first").await, "FIRST");
        assert_eq!(round_trip(forward.address, "again").await, "AGAIN");
        let address = forward.address;
        drop(forward);
        tokio::task::yield_now().await;
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(TcpStream::connect(address).await.is_err());
    }

    #[tokio::test]
    async fn a_destination_that_cannot_be_reached_is_said_when_the_port_opens() {
        let closed = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = closed.local_addr().unwrap().port();
        drop(closed);
        let dialer = Dialer::new(Route::Direct, Policy::AllowAll, Vec::new());
        let error = open(dialer, "127.0.0.1".into(), port).await.err().unwrap();
        assert!(error.to_string().contains("Cannot connect"), "{error}");
    }
}
