//! The loopback SOCKS5 proxy of a tunnel (RFC 1928, with RFC 1929 user name and password).
//! It asks for the tunnel's password, so no other program of the computer can use it, then
//! opens a channel from the bastion to the destination asked for and relays.
use super::Tunnel;
use std::{
    net::{Ipv4Addr, Ipv6Addr},
    sync::{Weak, atomic::Ordering},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use tokio_util::sync::CancellationToken;

pub(super) async fn serve(listener: TcpListener, tunnel: Weak<Tunnel>, stop: CancellationToken) {
    loop {
        let accepted = tokio::select! {
            _ = stop.cancelled() => return,
            accepted = listener.accept() => accepted,
        };
        let Ok((socket, _)) = accepted else {
            continue;
        };
        let Some(tunnel) = tunnel.upgrade() else {
            return;
        };
        tokio::spawn(async move {
            let _ = relay(socket, &tunnel).await;
        });
    }
}

/// Answers the request with `code`: 0 success, 5 refused, 7 command or 8 address not supported.
async fn reply(socket: &mut TcpStream, code: u8) -> std::io::Result<()> {
    socket.write_all(&[5, code, 0, 1, 0, 0, 0, 0, 0, 0]).await
}

async fn read_bytes(socket: &mut TcpStream, length: usize) -> std::io::Result<Vec<u8>> {
    let mut bytes = vec![0_u8; length];
    socket.read_exact(&mut bytes).await?;
    Ok(bytes)
}

async fn relay(mut socket: TcpStream, tunnel: &Tunnel) -> std::io::Result<()> {
    let greeting = read_bytes(&mut socket, 2).await?;
    if greeting[0] != 5 {
        return Ok(());
    }
    let methods = read_bytes(&mut socket, greeting[1].into()).await?;
    // Only the user name and password method: no anonymous use of the tunnel.
    if !methods.contains(&2) {
        return socket.write_all(&[5, 0xff]).await;
    }
    socket.write_all(&[5, 2]).await?;
    let version = read_bytes(&mut socket, 2).await?;
    let user = read_bytes(&mut socket, version[1].into()).await?;
    let length = read_bytes(&mut socket, 1).await?;
    let password = read_bytes(&mut socket, length[0].into()).await?;
    let expected = tunnel.credentials();
    let allowed = user == expected.username.as_bytes()
        && aws_lc_rs::constant_time::verify_slices_are_equal(
            &password,
            expected.password.as_bytes(),
        )
        .is_ok();
    socket.write_all(&[1, if allowed { 0 } else { 1 }]).await?;
    if !allowed {
        return Ok(());
    }
    let request = read_bytes(&mut socket, 4).await?;
    if request[1] != 1 {
        return reply(&mut socket, 7).await;
    }
    let host = match request[3] {
        1 => {
            let octets: [u8; 4] = read_bytes(&mut socket, 4)
                .await?
                .try_into()
                .unwrap_or_default();
            Ipv4Addr::from(octets).to_string()
        }
        3 => {
            let length = read_bytes(&mut socket, 1).await?;
            String::from_utf8_lossy(&read_bytes(&mut socket, length[0].into()).await?).into_owned()
        }
        4 => {
            let octets: [u8; 16] = read_bytes(&mut socket, 16)
                .await?
                .try_into()
                .unwrap_or_default();
            Ipv6Addr::from(octets).to_string()
        }
        _ => return reply(&mut socket, 8).await,
    };
    let port = read_bytes(&mut socket, 2).await?;
    let port = u16::from_be_bytes([port[0], port[1]]);
    tunnel.active.fetch_add(1, Ordering::SeqCst);
    tunnel.touch();
    let relayed = match tunnel.channel(&host, port).await {
        Ok(mut channel) => match reply(&mut socket, 0).await {
            Ok(()) => tokio::io::copy_bidirectional(&mut socket, &mut channel)
                .await
                .map(|_| ()),
            Err(error) => Err(error),
        },
        Err(_) => reply(&mut socket, 5).await,
    };
    tunnel.active.fetch_sub(1, Ordering::SeqCst);
    tunnel.touch();
    relayed
}
