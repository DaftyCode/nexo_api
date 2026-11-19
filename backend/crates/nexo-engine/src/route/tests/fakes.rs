//! Fake proxies for the route tests: an echo server, an HTTP proxy that answers CONNECT and a
//! SOCKS5 proxy (RFC 1928, 1929), each recording what it was asked.
use std::{
    net::SocketAddr,
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

/// An echo server: what it reads, it writes back.
pub async fn echo() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let (mut read, mut write) = socket.split();
                let _ = tokio::io::copy(&mut read, &mut write).await;
            });
        }
    });
    address
}

/// What a fake proxy was asked: the destination and the credentials.
pub type Asked = Arc<Mutex<Vec<String>>>;

/// An HTTP proxy that answers `CONNECT` with `status` and then relays to `upstream`.
pub async fn http_proxy(status: &'static str, upstream: SocketAddr) -> (u16, Asked) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let asked = Asked::default();
    let seen = asked.clone();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let seen = seen.clone();
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut byte = [0_u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    if socket.read(&mut byte).await.unwrap_or(0) == 0 {
                        return;
                    }
                    head.push(byte[0]);
                }
                seen.lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&head).into_owned());
                let answer = format!("HTTP/1.1 {status}\r\nVia: test\r\n\r\n");
                socket.write_all(answer.as_bytes()).await.unwrap();
                if status.starts_with("200") {
                    let mut target = tokio::net::TcpStream::connect(upstream).await.unwrap();
                    let _ = tokio::io::copy_bidirectional(&mut socket, &mut target).await;
                }
            });
        }
    });
    (port, asked)
}

/// A SOCKS5 proxy (RFC 1928 and 1929) that relays every request to `upstream` and records
/// the destination asked for, as `name:port` or `ip:port`, and the user name.
pub async fn socks_proxy(password: Option<&'static str>, upstream: SocketAddr) -> (u16, Asked) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let asked = Asked::default();
    let seen = asked.clone();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let seen = seen.clone();
            tokio::spawn(async move {
                let mut greeting = [0_u8; 2];
                socket.read_exact(&mut greeting).await.unwrap();
                let mut methods = vec![0_u8; greeting[1] as usize];
                socket.read_exact(&mut methods).await.unwrap();
                if let Some(expected) = password {
                    socket.write_all(&[5, 2]).await.unwrap();
                    let mut version = [0_u8; 2];
                    socket.read_exact(&mut version).await.unwrap();
                    let mut user = vec![0_u8; version[1] as usize];
                    socket.read_exact(&mut user).await.unwrap();
                    let mut length = [0_u8; 1];
                    socket.read_exact(&mut length).await.unwrap();
                    let mut pass = vec![0_u8; length[0] as usize];
                    socket.read_exact(&mut pass).await.unwrap();
                    let ok = pass == expected.as_bytes();
                    seen.lock()
                        .unwrap()
                        .push(format!("user {}", String::from_utf8_lossy(&user)));
                    socket
                        .write_all(&[1, if ok { 0 } else { 1 }])
                        .await
                        .unwrap();
                    if !ok {
                        return;
                    }
                } else {
                    socket.write_all(&[5, 0]).await.unwrap();
                }
                let mut request = [0_u8; 4];
                socket.read_exact(&mut request).await.unwrap();
                let destination = match request[3] {
                    3 => {
                        let mut length = [0_u8; 1];
                        socket.read_exact(&mut length).await.unwrap();
                        let mut name = vec![0_u8; length[0] as usize];
                        socket.read_exact(&mut name).await.unwrap();
                        String::from_utf8_lossy(&name).into_owned()
                    }
                    _ => {
                        let mut ip = [0_u8; 4];
                        socket.read_exact(&mut ip).await.unwrap();
                        std::net::Ipv4Addr::from(ip).to_string()
                    }
                };
                let mut port = [0_u8; 2];
                socket.read_exact(&mut port).await.unwrap();
                seen.lock()
                    .unwrap()
                    .push(format!("{destination}:{}", u16::from_be_bytes(port)));
                socket
                    .write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
                    .await
                    .unwrap();
                let mut target = tokio::net::TcpStream::connect(upstream).await.unwrap();
                let _ = tokio::io::copy_bidirectional(&mut socket, &mut target).await;
            });
        }
    });
    (port, asked)
}
