//! Limits every driver keeps, so the interface and the host stay responsive.
use std::time::Duration;

/// Rows in a page when the request does not say.
pub const PAGE_ROWS: u32 = 200;
/// The most rows a request may ask for in one page.
pub const MAX_PAGE_ROWS: u32 = 10_000;
/// Bytes of results in one answer: the page is cut before and the next one goes on.
pub const RESPONSE_BYTES: usize = 16 * 1024 * 1024;
/// Bytes of one value before it is cut and read whole only when asked.
pub const VALUE_BYTES: usize = 1024 * 1024;
/// How long one statement may run when its connection does not say.
pub const STATEMENT: Duration = Duration::from_secs(60);
/// How long to wait to open a connection.
pub const CONNECT: Duration = Duration::from_secs(10);

tokio::task_local! {
    /// The time of the connection being opened, when it has its own.
    static CONNECTING: Duration;
}

/// How long to wait to open a connection: its own time while it opens (the host sends it in
/// `connect`), or [`CONNECT`]. Drivers wait this long for each step of opening one.
pub fn connect() -> Duration {
    CONNECTING.try_with(|limit| *limit).unwrap_or(CONNECT)
}

/// Opens a connection within its own time, when it has one: past it, the opening stops and
/// nothing of it is kept.
pub async fn opening<T>(
    limit_ms: Option<u64>,
    open: impl Future<Output = crate::Result<T>>,
) -> crate::Result<T> {
    let Some(limit) = limit_ms.map(Duration::from_millis) else {
        return open.await;
    };
    let started = tokio::time::Instant::now();
    let late = || {
        crate::DriverError::timeout(format!(
            "The connection did not open within {} s",
            limit.as_secs().max(1)
        ))
    };
    match CONNECTING
        .scope(limit, tokio::time::timeout(limit, open))
        .await
    {
        Err(_) => Err(late()),
        // A step waits the same time (see `connect`): when it gives up as the time runs
        // out, which of the two the runtime looks at first is chance, and the answer is
        // the connection's time either way.
        Ok(Err(_)) if started.elapsed() >= limit => Err(late()),
        Ok(opened) => opened,
    }
}
/// Connections a driver keeps open at once.
pub const CONNECTIONS: usize = 16;
/// Cursors a driver keeps open at once; the oldest is closed for a new one.
pub const CURSORS: usize = 32;
/// How long a connection or a cursor nobody uses stays open.
pub const IDLE: Duration = Duration::from_secs(600);

/// The rows of a page for what a request asked.
pub fn page_rows(requested: Option<u32>) -> usize {
    requested.unwrap_or(PAGE_ROWS).clamp(1, MAX_PAGE_ROWS) as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_connection_opens_within_its_own_time_or_the_drivers() {
        assert_eq!(connect(), CONNECT);
        let seen = opening(Some(2_000), async { Ok(connect()) }).await.unwrap();
        assert_eq!(seen, Duration::from_secs(2));
        let slow = opening(Some(30), async {
            tokio::time::sleep(Duration::from_secs(5)).await;
            Ok(())
        })
        .await
        .unwrap_err();
        assert_eq!(slow.code, crate::ErrorCode::Timeout);
        assert_eq!(slow.message, "The connection did not open within 1 s");
        // A step that gives up as the time runs out is answered with the connection's time;
        // an error before it keeps its own message.
        let step = opening(Some(30), async {
            std::thread::sleep(Duration::from_millis(40));
            Err::<(), _>(crate::DriverError::network(
                "db:5432 did not answer in time",
            ))
        })
        .await
        .unwrap_err();
        assert_eq!(
            (step.code, step.message.as_str()),
            (
                crate::ErrorCode::Timeout,
                "The connection did not open within 1 s"
            )
        );
        let early = opening(Some(2_000), async {
            Err::<(), _>(crate::DriverError::auth("Wrong password"))
        })
        .await
        .unwrap_err();
        assert_eq!(early.message, "Wrong password");
        assert_eq!(
            opening(None, async { Ok(connect()) }).await.unwrap(),
            CONNECT
        );
    }
}
