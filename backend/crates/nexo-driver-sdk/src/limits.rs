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
