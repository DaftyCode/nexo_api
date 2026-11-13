//! TLS for tokio-postgres on rustls, with the SDK's configuration (aws-lc-rs and the
//! post-quantum key exchange first). tokio-postgres-rustls is not used: it depends on ring.
//!
//! It offers no channel binding, so SCRAM-SHA-256 is used rather than its `-PLUS` form,
//! which servers accept unless the client itself asks for channel binding.
use futures_util::future::BoxFuture;
use rustls_pki_types::ServerName;
use std::{
    io,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio_postgres::tls::{ChannelBinding, TlsConnect, TlsStream};
use tokio_rustls::{TlsConnector, client, rustls};

#[derive(Clone)]
pub(crate) struct RustlsConnect {
    pub config: Arc<rustls::ClientConfig>,
    pub server: ServerName<'static>,
}

pub(crate) struct RustlsStream<S>(client::TlsStream<S>);

impl<S> TlsConnect<S> for RustlsConnect
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    type Stream = RustlsStream<S>;
    type Error = io::Error;
    type Future = BoxFuture<'static, io::Result<RustlsStream<S>>>;

    fn connect(self, stream: S) -> Self::Future {
        Box::pin(async move {
            let stream = TlsConnector::from(self.config)
                .connect(self.server, stream)
                .await?;
            Ok(RustlsStream(stream))
        })
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> TlsStream for RustlsStream<S> {
    fn channel_binding(&self) -> ChannelBinding {
        ChannelBinding::none()
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncRead for RustlsStream<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_read(cx, buf)
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncWrite for RustlsStream<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.0).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_shutdown(cx)
    }
}
