//! What a proxy is told before it relays: `CONNECT` to an HTTP proxy and the SOCKS5 greeting
//! (RFC 1928, with RFC 1929 user name and password). Both leave a TCP stream that carries the
//! destination's bytes.
use super::Credentials;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use nexo_domain::{Error, Result};
use std::net::SocketAddr;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};
use tokio_socks::tcp::Socks5Stream;

/// The most an HTTP proxy may answer before its blank line.
const MAX_HEAD: usize = 16 * 1024;

fn refused(message: impl Into<String>) -> Error {
    Error::Validation(message.into())
}

/// Asks an HTTP proxy to open a tunnel to `host:port` and reads its answer up to the blank
/// line, byte by byte, so nothing of the destination's data is consumed.
pub(super) async fn http_connect(
    mut stream: TcpStream,
    host: &str,
    port: u16,
    credentials: Option<&Credentials>,
) -> Result<TcpStream> {
    let authority = super::authority(&super::Endpoint {
        host: host.to_string(),
        port,
    });
    let mut request = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n");
    if let Some(credentials) = credentials {
        let token = STANDARD.encode(format!("{}:{}", credentials.username, credentials.password));
        request.push_str(&format!("Proxy-Authorization: Basic {token}\r\n"));
    }
    request.push_str("\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|error| refused(format!("The proxy closed the connection: {error}")))?;
    let mut head = Vec::new();
    let mut byte = [0_u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() >= MAX_HEAD {
            return Err(refused("The proxy answered with headers that are too long"));
        }
        let read = stream
            .read(&mut byte)
            .await
            .map_err(|error| refused(format!("The proxy closed the connection: {error}")))?;
        if read == 0 {
            return Err(refused("The proxy closed the connection before answering"));
        }
        head.push(byte[0]);
    }
    let status = String::from_utf8_lossy(&head)
        .lines()
        .next()
        .unwrap_or_default()
        .to_string();
    match status.split_whitespace().nth(1) {
        Some("200") => Ok(stream),
        Some("407") => Err(refused(
            "The proxy asks for a user name and password (407 Proxy Authentication Required)",
        )),
        _ => Err(refused(format!(
            "The proxy refused to reach {authority}: {status}"
        ))),
    }
}

/// Greets a SOCKS5 proxy and asks it for `host:port`: the name itself when the proxy resolves
/// it (`target` is `None`), or the address the egress policy approved here.
pub(super) async fn socks5(
    stream: TcpStream,
    host: &str,
    port: u16,
    target: Option<SocketAddr>,
    credentials: Option<&Credentials>,
) -> Result<TcpStream> {
    let host = host.trim_matches(['[', ']']);
    let relayed = match (target, credentials) {
        (Some(address), None) => Socks5Stream::connect_with_socket(stream, address).await,
        (Some(address), Some(c)) => {
            Socks5Stream::connect_with_password_and_socket(
                stream,
                address,
                &c.username,
                &c.password,
            )
            .await
        }
        (None, None) => Socks5Stream::connect_with_socket(stream, (host, port)).await,
        (None, Some(c)) => {
            Socks5Stream::connect_with_password_and_socket(
                stream,
                (host, port),
                &c.username,
                &c.password,
            )
            .await
        }
    };
    relayed.map(Socks5Stream::into_inner).map_err(|error| {
        refused(format!(
            "The SOCKS5 proxy refused to reach {host}:{port}: {error}"
        ))
    })
}
