//! The SQL operations of the client protocol: `SQL_EXEC` (with the default schema, the page
//! size, the time limit, the time zone and the arguments), `SQL_CURSOR_NEXT_PAGE`,
//! `SQL_CURSOR_CLOSE`, `OPERATION_CANCEL` by the id of the request, and the transactions
//! (`TX_BEGIN`, `TX_COMMIT`, `TX_ROLLBACK`) whose id goes with each statement.
use crate::{
    client::Client,
    msgpack::{Reader, Writer},
    tuple::Builder,
    values::{self, Field},
};
use nexo_driver_sdk::{Result, Value};

const TX_BEGIN: i64 = 43;
const TX_COMMIT: i64 = 44;
const TX_ROLLBACK: i64 = 45;
const SQL_EXEC: i64 = 50;
const SQL_CURSOR_NEXT_PAGE: i64 = 51;
const SQL_CURSOR_CLOSE: i64 = 52;
const OPERATION_CANCEL: i64 = 70;

/// How a statement runs.
pub struct Statement<'a> {
    pub sql: &'a str,
    pub args: &'a [Value],
    pub schema: Option<&'a str>,
    pub page: usize,
    pub timeout_ms: u64,
    pub time_zone: &'a str,
    /// The transaction it runs in; none to commit it alone.
    pub transaction: Option<i64>,
}

/// What a statement answered: its columns and first page, and the cursor of the rest.
#[derive(Debug, Default)]
pub struct Answer {
    pub fields: Vec<Field>,
    pub rows: Vec<Vec<Value>>,
    /// The cursor the server keeps while there are more pages.
    pub cursor: Option<i64>,
    pub has_rows: bool,
    pub affected: i64,
}

fn write(writer: &mut Writer, statement: &Statement) -> Result<()> {
    match statement.transaction {
        Some(id) => writer.int(id),
        None => writer.nil(),
    };
    match statement.schema.filter(|schema| !schema.is_empty()) {
        Some(schema) => writer.str(schema),
        None => writer.nil(),
    };
    writer
        .int(statement.page as i64)
        .int(statement.timeout_ms as i64)
        // The session's idle time: the server's own.
        .nil()
        .str(statement.time_zone)
        // No properties: their count and an empty tuple.
        .int(0)
        .bin(&Builder::default().build())
        .str(statement.sql);
    match values::args::tuple(statement.args)? {
        Some(tuple) => writer.int(statement.args.len() as i64).bin(&tuple),
        None => writer.nil(),
    };
    Ok(())
}

/// The columns of a result (`ClientSqlCommon.packColumns`).
fn fields(reader: &mut Reader) -> Result<Vec<Field>> {
    let count = reader.int()?;
    let mut fields: Vec<Field> = Vec::new();
    for _ in 0..count {
        let properties = reader.int()?;
        let mut field = Field {
            name: reader.str()?,
            nullable: reader.bool()?,
            type_id: reader.int()?,
            scale: reader.int()?,
            precision: reader.int()?,
            origin: None,
        };
        let mut read = 6;
        if reader.bool()? && properties >= 9 {
            let column = reader.opt_str()?.unwrap_or_else(|| field.name.clone());
            // The schema and the table, or the index of a column before that has them.
            let schema = origin_name(reader, &fields, |origin| &origin.0)?;
            let table = origin_name(reader, &fields, |origin| &origin.1)?;
            field.origin = Some((schema, table, column));
            read = 9;
        }
        for _ in read..properties {
            reader.skip()?;
        }
        fields.push(field);
    }
    Ok(fields)
}

/// A name of a column's origin: written, or the index of an earlier column with the same.
fn origin_name(
    reader: &mut Reader,
    fields: &[Field],
    pick: fn(&(String, String, String)) -> &String,
) -> Result<String> {
    if reader.nil()? {
        return Ok(String::new());
    }
    let mut probe = Reader::new(reader.rest());
    if probe.str().is_ok() {
        return reader.str();
    }
    let index = reader.int()?;
    Ok(usize::try_from(index)
        .ok()
        .and_then(|index| fields.get(index))
        .and_then(|field| field.origin.as_ref())
        .map(|origin| pick(origin).clone())
        .unwrap_or_default())
}

/// The rows of a page: their count, then each one as a tuple.
fn rows(reader: &mut Reader, fields: &[Field]) -> Result<Vec<Vec<Value>>> {
    let count = reader.int()?;
    let mut rows = Vec::with_capacity(count.clamp(0, 10_000) as usize);
    for _ in 0..count {
        rows.push(values::row(reader.bin()?, fields)?);
    }
    Ok(rows)
}

/// Reads the answer of `SQL_EXEC`.
pub fn answer(bytes: &[u8]) -> Result<Answer> {
    let mut reader = Reader::new(bytes);
    let cursor = if reader.nil()? {
        None
    } else {
        Some(reader.int()?)
    };
    let has_rows = reader.bool()?;
    let more = reader.bool()?;
    let _applied = reader.bool()?;
    let affected = reader.int()?;
    let fields = fields(&mut reader)?;
    let rows = if has_rows {
        rows(&mut reader, &fields)?
    } else {
        Vec::new()
    };
    Ok(Answer {
        fields,
        rows,
        cursor: cursor.filter(|_| more),
        has_rows,
        affected,
    })
}

/// Runs a statement as request `id`, so that it can be cancelled by it.
pub async fn execute(client: &Client, id: i64, statement: &Statement<'_>) -> Result<Answer> {
    let mut payload = Writer::default();
    write(&mut payload, statement)?;
    let payload = payload.into_bytes();
    let observed = client.observed();
    let bytes = client
        .call_as(id, SQL_EXEC, |writer| {
            writer.raw(&payload).int(observed);
        })
        .await?;
    answer(&bytes)
}

/// The next page of a cursor, and whether the server keeps more.
pub async fn next_page(
    client: &Client,
    cursor: i64,
    fields: &[Field],
) -> Result<(Vec<Vec<Value>>, bool)> {
    let bytes = client
        .call(SQL_CURSOR_NEXT_PAGE, |writer| {
            writer.int(cursor);
        })
        .await?;
    let mut reader = Reader::new(&bytes);
    let rows = rows(&mut reader, fields)?;
    Ok((rows, reader.bool()?))
}

pub async fn close(client: &Client, cursor: i64) -> Result<()> {
    client
        .call(SQL_CURSOR_CLOSE, |writer| {
            writer.int(cursor);
        })
        .await
        .map(|_| ())
}

/// Cancels the statement sent as request `id`, if it still runs.
pub async fn cancel(client: &Client, id: i64) -> Result<()> {
    client
        .call(OPERATION_CANCEL, |writer| {
            writer.int(id);
        })
        .await
        .map(|_| ())
}

/// Begins a read-write transaction with the server's time limit, and answers its id.
pub async fn begin(client: &Client) -> Result<i64> {
    let bytes = client
        .call(TX_BEGIN, |writer| {
            writer.bool(false).int(0);
        })
        .await?;
    Reader::new(&bytes).int()
}

pub async fn finish(client: &Client, transaction: i64, commit: bool) -> Result<()> {
    let operation = if commit { TX_COMMIT } else { TX_ROLLBACK };
    client
        .call(operation, |writer| {
            writer.int(transaction);
        })
        .await
        .map(|_| ())
}

#[cfg(test)]
mod tests;
