//! Reading what a batch returns, as it comes, unless its statement is cancelled first.
use crate::values;
use futures_util::TryStreamExt;
use nexo_driver_sdk::{Column, Value, limits, statements::ResultSet};
use std::future::Future;
use tiberius::QueryItem;
use tokio::sync::mpsc;

/// The rows kept of each result after the first one.
const FURTHER_ROWS: usize = limits::MAX_PAGE_ROWS as usize;

pub(super) enum Wait<T> {
    Done(T),
    Cancelled,
}

/// Waits for `future` unless the statement `name` is cancelled first.
pub(super) async fn or_cancel<F: Future>(
    future: F,
    cancel: &mut mpsc::UnboundedReceiver<String>,
    name: &str,
) -> Wait<F::Output> {
    tokio::pin!(future);
    loop {
        tokio::select! {
            output = &mut future => return Wait::Done(output),
            asked = cancel.recv() => match asked {
                Some(asked) if asked == name => return Wait::Cancelled,
                Some(_) => continue,
                None => return Wait::Done(future.await),
            },
        }
    }
}

/// The first page of a batch's results, what follows read whole, and the row after the page.
pub(super) struct Read {
    pub first: Option<(Vec<Column>, Vec<Vec<Value>>)>,
    pub further: Vec<ResultSet>,
    pub pending: Option<tiberius::Row>,
}

pub(super) enum Interrupt {
    Failed(tiberius::error::Error),
    Cancelled,
}

/// Reads the first `limit` rows of the first result, and the further results whole, until
/// the first result has more rows than that or the batch ends.
pub(super) async fn read_first(
    stream: &mut tiberius::QueryStream<'_>,
    cancel: &mut mpsc::UnboundedReceiver<String>,
    name: &str,
    limit: u64,
) -> std::result::Result<Read, Interrupt> {
    let mut read = Read {
        first: None,
        further: Vec::new(),
        pending: None,
    };
    loop {
        let item = match or_cancel(stream.try_next(), cancel, name).await {
            Wait::Done(Ok(item)) => item,
            Wait::Done(Err(error)) => return Err(Interrupt::Failed(error)),
            Wait::Cancelled => return Err(Interrupt::Cancelled),
        };
        match item {
            None => return Ok(read),
            Some(QueryItem::Metadata(meta)) => {
                let columns = values::columns(meta.columns());
                if read.first.is_none() {
                    read.first = Some((columns, Vec::new()));
                } else {
                    read.further.push(ResultSet {
                        columns,
                        ..ResultSet::default()
                    });
                }
            }
            Some(QueryItem::Row(row)) => {
                match (read.further.last_mut(), read.first.as_mut()) {
                    (Some(set), _) if set.rows.is_empty() => values::refine(&mut set.columns, &row),
                    (None, Some((columns, rows))) if rows.is_empty() => {
                        values::refine(columns, &row)
                    }
                    _ => {}
                }
                match (read.further.last_mut(), read.first.as_mut()) {
                    (Some(set), _) if set.rows.len() >= FURTHER_ROWS => set.truncated = true,
                    (Some(set), _) => set.rows.push(values::row(row)),
                    (None, Some((_, rows))) if rows.len() as u64 >= limit => {
                        read.pending = Some(row);
                        return Ok(read);
                    }
                    (None, Some((_, rows))) => rows.push(values::row(row)),
                    (None, None) => {}
                }
            }
        }
    }
}
