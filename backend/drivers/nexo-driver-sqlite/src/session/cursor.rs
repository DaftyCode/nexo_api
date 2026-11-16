//! An open result: its rows read a page at a time, one row read ahead so a page that ends
//! the result says so, until it ends, is closed, or another request comes.
use super::Command;
use crate::{errors::database, guard::Guard, values};
use nexo_driver_sdk::{Value, limits, statements::Page};
use rusqlite::Rows;
use tokio::sync::mpsc;

/// The next row of a result, as values.
fn next_row(rows: &mut Rows<'_>, width: usize) -> rusqlite::Result<Option<Vec<Value>>> {
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    let values = (0..width)
        .map(|index| row.get_ref(index).map(values::value))
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Some(values))
}

/// Up to `count` rows, after the one read ahead; and whether the result ended. One more row
/// is read ahead, so that a result that ends with its page says so.
pub(super) fn page(
    rows: &mut Rows<'_>,
    ahead: &mut Option<Vec<Value>>,
    count: u64,
    width: usize,
    look: bool,
) -> rusqlite::Result<(Vec<Vec<Value>>, bool)> {
    let mut page: Vec<Vec<Value>> = ahead.take().into_iter().collect();
    while (page.len() as u64) < count {
        match next_row(rows, width)? {
            Some(row) => page.push(row),
            None => return Ok((page, true)),
        }
    }
    if !look {
        return Ok((page, true));
    }
    *ahead = next_row(rows, width)?;
    Ok((page, ahead.is_none()))
}

/// Serves the pages of an open result until it ends, is closed, or another request comes.
#[allow(clippy::too_many_arguments)]
pub(super) fn keep_open(
    mut rows: Rows<'_>,
    mut ahead: Option<Vec<Value>>,
    width: usize,
    mut read: u64,
    max_rows: Option<u64>,
    cursor: &str,
    guard: &Guard,
    commands: &mut mpsc::Receiver<Command>,
) -> Option<Command> {
    loop {
        let command = commands.blocking_recv()?;
        match command {
            Command::Fetch {
                cursor: wanted,
                rows: count,
                reply,
            } if wanted == cursor => {
                let count = max_rows.map_or(count, |max| max.saturating_sub(read).min(count));
                let look = max_rows.is_none_or(|max| read + count < max);
                guard.arm(limits::STATEMENT);
                let outcome = page(&mut rows, &mut ahead, count, width, look);
                guard.disarm();
                let (found, ended) = match outcome {
                    Ok(found) => found,
                    Err(error) => {
                        let _ = reply.send(Err(database(error, None, guard, false)));
                        return None;
                    }
                };
                read += found.len() as u64;
                let _ = reply.send(Ok(Page {
                    rows: found,
                    cursor: (!ended).then(|| cursor.to_owned()),
                }));
                if ended {
                    return None;
                }
            }
            Command::Close {
                cursor: wanted,
                reply,
            } if wanted == cursor => {
                let _ = reply.send(Ok(()));
                return None;
            }
            // Anything else ends the result: its statement is reset when it is dropped.
            other => return Some(other),
        }
    }
}
