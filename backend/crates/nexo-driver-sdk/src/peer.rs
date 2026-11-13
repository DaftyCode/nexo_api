//! One end of the conversation: it sends requests and waits for their answers, and answers
//! the other side's requests, several at a time.
use crate::{
    DriverError, Result,
    wire::{Message, read_line},
};
use async_trait::async_trait;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::{
    io::{AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    sync::{mpsc, oneshot},
    task::JoinHandle,
};

/// Answers what the other side asks.
#[async_trait]
pub trait Handler: Send + Sync + 'static {
    async fn request(&self, method: &str, params: Value) -> Result<Value>;
    async fn notification(&self, _method: &str, _params: Value) {}
}

type Waiting = HashMap<u64, oneshot::Sender<Result<Value>>>;

struct Inner {
    /// Lines waiting to be written; `None` once the conversation is closed.
    outgoing: Mutex<Option<mpsc::Sender<String>>>,
    /// Requests waiting for their answer; `None` once the conversation is closed.
    waiting: Mutex<Option<Waiting>>,
    next: AtomicU64,
}

#[derive(Clone)]
pub struct Peer {
    inner: Arc<Inner>,
}

/// Forgets a request nobody waits for any more (its caller gave up).
struct Forget<'a>(&'a Inner, u64);
impl Drop for Forget<'_> {
    fn drop(&mut self) {
        if let Some(waiting) = self.0.waiting.lock().unwrap().as_mut() {
            waiting.remove(&self.1);
        }
    }
}

fn closed() -> DriverError {
    DriverError::closed("The driver connection is closed")
}

impl Peer {
    /// Starts reading `reader` and writing to `writer`. `handler` receives the peer, to ask
    /// the other side while it answers. The task ends when the input does.
    pub fn start<R, W, H>(
        reader: R,
        writer: W,
        handler: impl FnOnce(Peer) -> H,
    ) -> (Self, JoinHandle<()>)
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
        H: Handler,
    {
        let (outgoing, lines) = mpsc::channel(64);
        let peer = Self {
            inner: Arc::new(Inner {
                outgoing: Mutex::new(Some(outgoing)),
                waiting: Mutex::new(Some(HashMap::new())),
                next: AtomicU64::new(1),
            }),
        };
        let handler = Arc::new(handler(peer.clone()));
        tokio::spawn(write(writer, lines));
        let task = tokio::spawn(read(reader, peer.clone(), handler));
        (peer, task)
    }

    /// Asks the other side and waits for its answer.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.inner.next.fetch_add(1, Ordering::Relaxed);
        let (answer, answered) = oneshot::channel();
        match self.inner.waiting.lock().unwrap().as_mut() {
            Some(waiting) => waiting.insert(id, answer),
            None => return Err(closed()),
        };
        let _forget = Forget(&self.inner, id);
        let method = method.to_owned();
        self.send(Message::Request { id, method, params }).await?;
        answered.await.unwrap_or_else(|_| Err(closed()))
    }

    /// Tells the other side something it does not answer.
    pub async fn notify(&self, method: &str, params: Value) {
        let method = method.to_owned();
        let _ = self.send(Message::Notification { method, params }).await;
    }

    /// Stops writing (the other side sees the end of its input) and fails what waits.
    pub fn close(&self) {
        self.inner.outgoing.lock().unwrap().take();
        if let Some(waiting) = self.inner.waiting.lock().unwrap().take() {
            for answer in waiting.into_values() {
                let _ = answer.send(Err(closed()));
            }
        }
    }

    pub fn is_closed(&self) -> bool {
        self.inner.waiting.lock().unwrap().is_none()
    }

    /// Requests still waiting for their answer.
    #[cfg(test)]
    pub(crate) fn waiting(&self) -> usize {
        let waiting = self.inner.waiting.lock().unwrap();
        waiting.as_ref().map_or(0, HashMap::len)
    }

    async fn send(&self, message: Message) -> Result<()> {
        let outgoing = self.inner.outgoing.lock().unwrap().clone();
        let outgoing = outgoing.ok_or_else(closed)?;
        outgoing.send(message.to_line()).await.map_err(|_| closed())
    }

    fn answer(&self, id: u64, outcome: Result<Value>) {
        let answer = match self.inner.waiting.lock().unwrap().as_mut() {
            Some(waiting) => waiting.remove(&id),
            None => None,
        };
        if let Some(answer) = answer {
            let _ = answer.send(outcome);
        }
    }
}

async fn write<W: AsyncWrite + Unpin>(mut writer: W, mut lines: mpsc::Receiver<String>) {
    while let Some(mut line) = lines.recv().await {
        line.push('\n');
        if writer.write_all(line.as_bytes()).await.is_err() || writer.flush().await.is_err() {
            break;
        }
    }
    let _ = writer.shutdown().await;
}

async fn read<R, H>(reader: R, peer: Peer, handler: Arc<H>)
where
    R: AsyncRead + Unpin,
    H: Handler,
{
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    while let Ok(true) = read_line(&mut reader, &mut line).await {
        // A line that is not a message is skipped: the conversation goes on.
        let Some(message) = std::str::from_utf8(&line)
            .ok()
            .filter(|text| !text.trim().is_empty())
            .and_then(|text| Message::parse(text).ok())
        else {
            continue;
        };
        match message {
            Message::Request { id, method, params } => {
                let (peer, handler) = (peer.clone(), handler.clone());
                tokio::spawn(async move {
                    let outcome = handler.request(&method, params).await;
                    let _ = peer.send(Message::Response { id, outcome }).await;
                });
            }
            Message::Response { id, outcome } => peer.answer(id, outcome),
            Message::Notification { method, params } => {
                let handler = handler.clone();
                tokio::spawn(async move { handler.notification(&method, params).await });
            }
        }
    }
    peer.close();
}
