//! MQTT 3.1.1 connection over TCP, TLS or WebSocket. Packets are encoded and decoded by
//! `rumqttc`'s codec; transports and TLS are this crate's, so they follow the egress policy
//! and the shared TLS settings.
use bytes::BytesMut;
use futures_util::{SinkExt, StreamExt};
use rumqttc::{Packet, mqttbytes::Error as PacketError};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpStream,
};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, tungstenite::Message};

/// Largest packet sent or accepted.
pub const MAX_PACKET: usize = 8 * 1024 * 1024;

pub trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}

pub enum Link {
    /// TCP or TLS byte stream.
    Stream(Box<dyn Stream>),
    /// MQTT over WebSocket: each binary message carries packet bytes.
    Socket(Box<WebSocketStream<MaybeTlsStream<TcpStream>>>),
}

pub struct Connection {
    link: Link,
    buffer: BytesMut,
}
impl Connection {
    pub fn new(link: Link) -> Self {
        Self {
            link,
            buffer: BytesMut::with_capacity(4096),
        }
    }
    pub async fn send(&mut self, packet: &Packet) -> Result<(), String> {
        let mut bytes = BytesMut::new();
        packet
            .write(&mut bytes, MAX_PACKET)
            .map_err(|error| error.to_string())?;
        match &mut self.link {
            Link::Stream(stream) => {
                stream.write_all(&bytes).await.map_err(|e| e.to_string())?;
                stream.flush().await.map_err(|e| e.to_string())
            }
            Link::Socket(socket) => socket
                .send(Message::binary(bytes.to_vec()))
                .await
                .map_err(|e| e.to_string()),
        }
    }
    /// The next packet, or `None` when the broker closed the connection. Cancel safe:
    /// bytes already received stay in the buffer.
    pub async fn next(&mut self) -> Result<Option<Packet>, String> {
        loop {
            match Packet::read(&mut self.buffer, MAX_PACKET) {
                Ok(packet) => return Ok(Some(packet)),
                Err(PacketError::InsufficientBytes(_)) => {}
                Err(error) => return Err(error.to_string()),
            }
            match &mut self.link {
                Link::Stream(stream) => {
                    let read = stream
                        .read_buf(&mut self.buffer)
                        .await
                        .map_err(|e| e.to_string())?;
                    if read == 0 {
                        return Ok(None);
                    }
                }
                Link::Socket(socket) => match socket.next().await {
                    Some(Ok(Message::Binary(bytes))) => self.buffer.extend_from_slice(&bytes),
                    Some(Ok(Message::Close(_))) | None => return Ok(None),
                    Some(Ok(_)) => {}
                    Some(Err(error)) => return Err(error.to_string()),
                },
            }
        }
    }
}
