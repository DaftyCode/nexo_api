//! The loop of a driver: it reads requests, hands them to the [`Driver`] and writes its
//! answers, several at a time.
use crate::{Driver, DriverError, Handler, HostLink, Peer, Result, methods, protocol::TreeNodes};
use async_trait::async_trait;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncWrite};

struct Dispatcher<D> {
    driver: Arc<D>,
    host: HostLink,
}

fn read<T: DeserializeOwned>(params: Value) -> Result<T> {
    serde_json::from_value(params)
        .map_err(|error| DriverError::invalid(format!("Invalid request: {error}")))
}
fn write<T: Serialize>(answer: T) -> Result<Value> {
    serde_json::to_value(answer)
        .map_err(|error| DriverError::internal(format!("Unwritable answer: {error}")))
}

#[async_trait]
impl<D: Driver> Handler for Dispatcher<D> {
    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let (driver, host) = (&self.driver, &self.host);
        match method {
            methods::HELLO => write(driver.hello()),
            methods::CONNECT => write(driver.connect(host, read(params)?).await?),
            methods::TEST => write(driver.test(host, read(params)?).await?),
            methods::DISCONNECT => {
                let params: crate::protocol::ConnectionParams = read(params)?;
                write(driver.disconnect(&params.connection).await?)
            }
            methods::TREE => write(TreeNodes {
                nodes: driver.tree(read(params)?).await?,
            }),
            methods::DESCRIBE => write(driver.describe(read(params)?).await?),
            methods::DDL => write(driver.ddl(read(params)?).await?),
            methods::EXECUTE => write(driver.execute(read(params)?).await?),
            methods::FETCH => write(driver.fetch(read(params)?).await?),
            methods::CLOSE => write(driver.close(read(params)?).await?),
            methods::CANCEL => write(driver.cancel(read(params)?).await?),
            methods::TRANSACTION => write(driver.transaction(read(params)?).await?),
            other => driver.extension(host, other, params).await,
        }
    }
}

/// Serves `driver` over a pair of streams until the input ends.
pub async fn serve<D, R, W>(driver: D, reader: R, writer: W)
where
    D: Driver,
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let driver = Arc::new(driver);
    let (_, task) = Peer::start(reader, writer, |peer| Dispatcher {
        driver,
        host: HostLink::new(peer),
    });
    let _ = task.await;
}

/// Serves `driver` over the standard input and output of its process, and ends the process
/// when the input ends: that is how a driver stops when Nexo closes it or dies.
pub async fn run<D: Driver>(driver: D) -> ! {
    serve(driver, tokio::io::stdin(), tokio::io::stdout()).await;
    // Whatever the driver still has running (a blocked library call) must not keep the
    // process alive without a host.
    std::process::exit(0)
}
