//! Reading what a statement returns, as it comes: the first result up to a page, the
//! next ones whole, and the rows a write changed.
use crate::values;
use mysql_async::{Column as MyColumn, QueryResult, Row, prelude::Protocol};
use nexo_driver_sdk::{Column, Value, limits, statements::ResultSet};
use std::sync::Arc;

/// The rows kept of each result after the first one.
const FURTHER_ROWS: usize = limits::MAX_PAGE_ROWS as usize;
/// The results a statement may return: a guard against a reply that never ends.
const RESULTS: usize = 10_000;

/// The first result: its columns as the protocol describes them, its rows, and the
/// server's columns to read the rest of its rows.
pub(super) type First = (Vec<Column>, Vec<Vec<Value>>, Option<Arc<[MyColumn]>>);

/// What a statement returned up to the first page: the first result, the further ones whole,
/// and the row after the page when there are more.
#[derive(Default)]
pub(super) struct Read {
    pub first: Option<First>,
    pub further: Vec<ResultSet>,
    pub pending: Option<Row>,
    pub affected: Option<u64>,
    pub inserted: Option<u64>,
}

/// Reads the first `limit` rows of the first result with rows, and what follows it whole,
/// until the first result has more rows than that or the statement ends.
pub(super) async fn read_first<P: Protocol>(
    result: &mut QueryResult<'_, '_, P>,
    limit: u64,
) -> std::result::Result<Read, mysql_async::Error> {
    let mut read = Read::default();
    for _ in 0..RESULTS {
        match result.columns() {
            Some(columns) if !columns.is_empty() => {
                let described = values::columns(&columns);
                if read.first.is_none() {
                    let mut rows = Vec::new();
                    while let Some(row) = result.next().await? {
                        if rows.len() as u64 >= limit {
                            read.first = Some((described, rows, Some(columns)));
                            read.pending = Some(row);
                            return Ok(read);
                        }
                        rows.push(values::row(row, &columns));
                    }
                    read.first = Some((described, rows, Some(columns)));
                } else {
                    let mut set = ResultSet {
                        columns: described,
                        ..ResultSet::default()
                    };
                    while let Some(row) = result.next().await? {
                        if set.rows.len() >= FURTHER_ROWS {
                            set.truncated = true;
                        } else {
                            set.rows.push(values::row(row, &columns));
                        }
                    }
                    read.further.push(set);
                }
            }
            _ => {
                // A result without columns: a write, or the status at the end of a procedure.
                *read.affected.get_or_insert(0) += result.affected_rows();
                if let Some(id) = result.last_insert_id().filter(|id| *id > 0) {
                    read.inserted = Some(id);
                }
                result.next().await?;
            }
        }
        if result.is_empty() {
            break;
        }
    }
    Ok(read)
}

/// A result of either protocol: text for statements without parameters, binary for those
/// with them.
pub(super) enum Either<'a, 't> {
    Text(QueryResult<'a, 't, mysql_async::TextProtocol>),
    Binary(QueryResult<'a, 't, mysql_async::BinaryProtocol>),
}
impl Either<'_, '_> {
    /// The next row of the result being read.
    pub(super) async fn next(&mut self) -> std::result::Result<Option<Row>, mysql_async::Error> {
        match self {
            Self::Text(result) => result.next().await,
            Self::Binary(result) => result.next().await,
        }
    }
    /// Reads what is left of the result, so the connection can take the next request.
    pub(super) async fn drop_result(self) -> std::result::Result<(), mysql_async::Error> {
        match self {
            Self::Text(result) => result.drop_result().await,
            Self::Binary(result) => result.drop_result().await,
        }
    }
}
