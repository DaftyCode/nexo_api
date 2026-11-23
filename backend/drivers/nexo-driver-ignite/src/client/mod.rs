//! A connection to a node of Ignite 3 by its client protocol (port 10800): the magic `IGNI`,
//! the handshake, then messages of a 4-byte big-endian length and their MessagePack. Each
//! request carries an id and its answer says which one it answers, so a statement can be
//! cancelled on the same connection while it runs. The node is reached at the address the
//! host resolved (`net.resolve`), with TLS on the SDK's rustls settings when asked.
pub mod errors;
pub mod handshake;
mod stream;

use crate::msgpack::{Reader, Writer, broken};
use handshake::Node;
use nexo_driver_sdk::{DriverError, HostLink, Result, protocol::ConnectParams};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicI64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadHalf, WriteHalf},
    sync::oneshot,
    task::JoinHandle,
};

/// The client port of Ignite 3.
pub const PORT: u16 = 10800;
/// What opens the conversation, both ways.
const MAGIC: &[u8; 4] = b"IGNI";
/// The largest message read; a page of rows is far smaller.
const MAX_MESSAGE: usize = 256 << 20;
/// Answers carry these flags (`ResponseFlags`).
const PARTITIONS_CHANGED: i64 = 1;
const NOTIFICATION: i64 = 2;
const ERROR: i64 = 4;
/// The operation that keeps an idle connection open.
const HEARTBEAT: i64 = 1;

type Answer = Result<Vec<u8>>;
type Waiting = Arc<Mutex<HashMap<i64, oneshot::Sender<Answer>>>>;

pub trait Io: AsyncRead + AsyncWrite + Unpin + Send + 'static {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + 'static> Io for T {}

pub struct Client {
    writer: tokio::sync::Mutex<WriteHalf<Box<dyn Io>>>,
    waiting: Waiting,
    next: AtomicI64,
    /// The latest time the cluster has shown, sent back so later reads see earlier writes.
    observed: Arc<AtomicI64>,
    closed: Arc<AtomicBool>,
    pub node: Node,
    pub tls: bool,
    tasks: Mutex<Vec<JoinHandle<()>>>,
}

fn ended() -> DriverError {
    DriverError::closed("The connection to Ignite was closed")
}

fn frame(payload: &[u8]) -> Vec<u8> {
    let mut bytes = (payload.len() as u32).to_be_bytes().to_vec();
    bytes.extend(payload);
    bytes
}

async fn read_frame(reader: &mut (impl AsyncRead + Unpin)) -> Result<Vec<u8>> {
    let mut length = [0u8; 4];
    reader.read_exact(&mut length).await.map_err(|_| ended())?;
    let length = u32::from_be_bytes(length) as usize;
    if length > MAX_MESSAGE {
        return Err(broken("a message too large"));
    }
    let mut payload = vec![0; length];
    reader.read_exact(&mut payload).await.map_err(|_| ended())?;
    Ok(payload)
}

/// The id an answer is for, and what it carries: its payload or the error it reports.
fn parse_answer(bytes: &[u8], observed: &AtomicI64) -> Result<(i64, i64, Answer)> {
    let mut reader = Reader::new(bytes);
    let id = reader.int()?;
    let flags = reader.int()?;
    if flags & PARTITIONS_CHANGED != 0 {
        reader.int()?;
    }
    observed.fetch_max(reader.int()?, Ordering::Relaxed);
    if flags & ERROR != 0 {
        return Ok((id, flags, Err(errors::read(&mut reader)?)));
    }
    let start = bytes.len() - reader.rest().len();
    Ok((id, flags, Ok(bytes[start..].to_vec())))
}

impl Client {
    /// Opens a connection to the node of `params`, within the time to connect.
    pub async fn open(host: &HostLink, params: &ConnectParams) -> Result<Self> {
        let (io, tls) = stream::open(host, params).await?;
        let (user, password) = (params.user.as_deref(), params.password.as_deref());
        Self::start(io, tls, user, password).await
    }

    /// Greets the node over an open socket and starts reading its answers.
    pub async fn start(
        io: Box<dyn Io>,
        tls: bool,
        user: Option<&str>,
        password: Option<&str>,
    ) -> Result<Self> {
        let (mut reader, mut writer) = tokio::io::split(io);
        let mut hello = MAGIC.to_vec();
        hello.extend(frame(&handshake::request(user, password)));
        let greeting = async {
            writer.write_all(&hello).await.map_err(|_| ended())?;
            let mut magic = [0u8; 4];
            reader.read_exact(&mut magic).await.map_err(|_| ended())?;
            if &magic != MAGIC {
                return Err(DriverError::network("The server is not an Ignite 3 node"));
            }
            handshake::response(&read_frame(&mut reader).await?)
        };
        let node = tokio::time::timeout(nexo_driver_sdk::limits::connect(), greeting)
            .await
            .map_err(|_| DriverError::timeout("Ignite did not answer the handshake in time"))??;
        let client = Self {
            writer: tokio::sync::Mutex::new(writer),
            waiting: Arc::default(),
            next: AtomicI64::new(1),
            observed: Arc::new(AtomicI64::new(node.observed)),
            closed: Arc::default(),
            node,
            tls,
            tasks: Mutex::default(),
        };
        client.listen(reader);
        Ok(client)
    }

    fn listen(&self, mut reader: ReadHalf<Box<dyn Io>>) {
        let (waiting, observed, closed) = (
            self.waiting.clone(),
            self.observed.clone(),
            self.closed.clone(),
        );
        let task = tokio::spawn(async move {
            while let Ok(bytes) = read_frame(&mut reader).await {
                let Ok((id, flags, answer)) = parse_answer(&bytes, &observed) else {
                    break;
                };
                // A notification answers no request: this driver asks for none.
                if flags & NOTIFICATION != 0 {
                    continue;
                }
                if let Some(sender) = waiting.lock().unwrap().remove(&id) {
                    let _ = sender.send(answer);
                }
            }
            closed.store(true, Ordering::Relaxed);
            for (_, sender) in waiting.lock().unwrap().drain() {
                let _ = sender.send(Err(ended()));
            }
        });
        self.tasks.lock().unwrap().push(task);
    }

    /// Sends a heartbeat now and then when the node closes idle connections.
    pub fn keep_alive(self: &Arc<Self>) {
        if self.node.idle_ms <= 0 {
            return;
        }
        let every = Duration::from_millis((self.node.idle_ms / 3).max(500) as u64);
        let client = Arc::downgrade(self);
        let task = tokio::spawn(async move {
            loop {
                tokio::time::sleep(every).await;
                let Some(client) = client.upgrade() else {
                    break;
                };
                if client.is_closed() || client.call(HEARTBEAT, |_| {}).await.is_err() {
                    break;
                }
            }
        });
        self.tasks.lock().unwrap().push(task);
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Relaxed)
    }
    pub fn observed(&self) -> i64 {
        self.observed.load(Ordering::Relaxed)
    }

    /// The id the next request will have.
    pub fn reserve(&self) -> i64 {
        self.next.fetch_add(1, Ordering::Relaxed)
    }

    /// Sends a request and waits for its answer.
    pub async fn call(&self, operation: i64, write: impl FnOnce(&mut Writer)) -> Result<Vec<u8>> {
        self.call_as(self.reserve(), operation, write).await
    }

    /// Sends a request with an id taken before, so that it can be cancelled by it.
    pub async fn call_as(
        &self,
        id: i64,
        operation: i64,
        write: impl FnOnce(&mut Writer),
    ) -> Result<Vec<u8>> {
        if self.is_closed() {
            return Err(ended());
        }
        let mut writer = Writer::default();
        writer.int(operation).int(id);
        write(&mut writer);
        let message = frame(&writer.into_bytes());
        let (sender, receiver) = oneshot::channel();
        self.waiting.lock().unwrap().insert(id, sender);
        let sent = self.writer.lock().await.write_all(&message).await;
        if sent.is_err() {
            self.waiting.lock().unwrap().remove(&id);
            return Err(ended());
        }
        receiver.await.map_err(|_| ended())?
    }

    pub async fn close(&self) {
        let _ = self.writer.lock().await.shutdown().await;
        for task in self.tasks.lock().unwrap().drain(..) {
            task.abort();
        }
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        for task in self.tasks.lock().unwrap().drain(..) {
            task.abort();
        }
    }
}

#[cfg(test)]
mod tests;
