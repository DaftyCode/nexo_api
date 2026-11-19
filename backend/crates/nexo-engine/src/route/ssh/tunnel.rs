//! A tunnel: its loopback SOCKS5 port and its session to the bastion, opened when needed and
//! closed after a while unused.
use super::{IDLE, SshTarget, lock, server, session, tunnels};
use crate::{
    egress::Policy,
    route::{Credentials, Endpoint, dialer::loopback},
};
use nexo_domain::{Error, Result};
use std::{
    net::Ipv4Addr,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

/// A tunnel: its loopback SOCKS5 port and its session to the bastion, opened when needed.
pub struct Tunnel {
    pub(super) target: SshTarget,
    pub(super) egress: Policy,
    pub(super) loopback_ports: Vec<u16>,
    pub port: u16,
    pub(super) password: String,
    pub(super) session: tokio::sync::Mutex<Option<russh::client::Handle<session::Client>>>,
    pub(super) active: AtomicUsize,
    pub(super) last_used: Mutex<Instant>,
    pub(super) stopped: AtomicBool,
    /// Stops the loopback listener when the tunnel closes.
    pub(super) stop: CancellationToken,
}

impl Tunnel {
    pub(super) fn listen(
        target: SshTarget,
        egress: Policy,
        loopback_ports: Vec<u16>,
    ) -> Result<Arc<Self>> {
        let runtime = tokio::runtime::Handle::try_current()
            .map_err(|_| Error::Infrastructure("SSH tunnels need the engine's runtime".into()))?;
        let failed = |error: std::io::Error| {
            Error::Infrastructure(format!("The SSH tunnel cannot listen on loopback: {error}"))
        };
        let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(failed)?;
        listener.set_nonblocking(true).map_err(failed)?;
        let port = listener.local_addr().map_err(failed)?.port();
        let tunnel = Arc::new(Self {
            target,
            egress,
            loopback_ports,
            port,
            password: uuid::Uuid::new_v4().simple().to_string(),
            session: tokio::sync::Mutex::new(None),
            active: AtomicUsize::new(0),
            last_used: Mutex::new(Instant::now()),
            stopped: AtomicBool::new(false),
            stop: CancellationToken::new(),
        });
        let (served, stop) = (Arc::downgrade(&tunnel), tunnel.stop.clone());
        runtime.spawn(async move {
            if let Ok(listener) = tokio::net::TcpListener::from_std(listener) {
                server::serve(listener, served, stop).await;
            }
        });
        runtime.spawn(watch(Arc::downgrade(&tunnel)));
        Ok(tunnel)
    }
    pub fn endpoint(&self) -> Endpoint {
        loopback(self.port)
    }
    /// What the loopback SOCKS5 proxy asks for, so no other program can use the tunnel.
    pub fn credentials(&self) -> Credentials {
        Credentials {
            username: "nexo".into(),
            password: self.password.clone(),
        }
    }
    pub(super) fn touch(&self) {
        *lock(&self.last_used) = Instant::now();
    }
    /// Opens the session if it is not open, or opens it again after it closed.
    pub async fn ensure(&self) -> Result<()> {
        let mut session = self.session.lock().await;
        self.touch();
        if session.as_ref().is_some_and(|handle| !handle.is_closed()) {
            return Ok(());
        }
        let opened = session::open(&self.target, tunnels(), &self.egress, &self.loopback_ports)
            .await
            .map_err(Error::from)?;
        *session = Some(opened.handle);
        Ok(())
    }
    /// A channel from the bastion to `host:port`.
    pub(super) async fn channel(
        &self,
        host: &str,
        port: u16,
    ) -> Result<russh::ChannelStream<russh::client::Msg>> {
        self.ensure().await?;
        let session = self.session.lock().await;
        let handle = session
            .as_ref()
            .ok_or_else(|| Error::Validation("The SSH session closed".into()))?;
        let channel = handle
            .channel_open_direct_tcpip(host, u32::from(port), "127.0.0.1", 0)
            .await
            .map_err(|error| {
                Error::Validation(format!(
                    "The SSH server {} could not reach {host}:{port}: {error}",
                    self.target.address()
                ))
            })?;
        Ok(channel.into_stream())
    }
    pub(super) async fn close(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.stop.cancel();
        if let Some(handle) = self.session.lock().await.take() {
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
        }
    }
}

/// Closes a tunnel left unused for [`IDLE`]; a later request opens a new one.
async fn watch(tunnel: Weak<Tunnel>) {
    loop {
        tokio::time::sleep(Duration::from_secs(30)).await;
        let Some(tunnel) = tunnel.upgrade() else {
            return;
        };
        let idle = lock(&tunnel.last_used).elapsed();
        if tunnel.active.load(Ordering::SeqCst) == 0 && idle > IDLE {
            tunnels().forget(&tunnel);
            tunnel.close().await;
            return;
        }
    }
}
