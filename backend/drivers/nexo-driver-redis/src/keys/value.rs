//! A key's sheet: its type, expiry, encoding and size, and its value by its type, a
//! collection by pages from where the last page stopped.
use super::{MAX, PAGE};
use crate::{
    connection::{Conn, failure},
    reply::{bytes, cell, integer, items, raw, text},
};
use nexo_driver_sdk::{
    DriverError, Result, Value as Cell,
    keyvalue::{Element, GetParams, KeyValue},
};
use redis::{Cmd, cmd};

/// A key with its value; a collection by pages from `cursor`.
pub(crate) async fn get(connection: &Conn, params: GetParams) -> Result<KeyValue> {
    let key = bytes(&params.key)?;
    let run = |command: Cmd| async move { connection.run(&command).await.map_err(failure) };
    let kind = text(&run(cmd("TYPE").arg(&key).clone()).await?).unwrap_or_default();
    if kind == "none" {
        return Err(DriverError::invalid(
            "The key does not exist (or has just expired)",
        ));
    }
    let ttl = integer(&run(cmd("PTTL").arg(&key).clone()).await?).unwrap_or(-1);
    let encoding = run(cmd("OBJECT").arg("ENCODING").arg(&key).clone())
        .await
        .ok()
        .and_then(|value| text(&value));
    // MEMORY USAGE may be refused by the server's ACL: then the size is not known.
    let size = run(cmd("MEMORY").arg("USAGE").arg(&key).clone())
        .await
        .ok()
        .and_then(|value| integer(&value))
        .and_then(|size| u64::try_from(size).ok());
    let count = params.count.unwrap_or(PAGE).clamp(1, MAX);
    let start: i64 = params
        .cursor
        .as_deref()
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let scan_cursor = params.cursor.clone().unwrap_or_else(|| "0".into());
    let mut value = KeyValue {
        key: cell(&key),
        kind: kind.clone(),
        ttl_ms: (ttl >= 0).then_some(ttl),
        encoding,
        size,
        ..KeyValue::default()
    };
    let length = |name: &str| cmd(name).arg(&key).clone();
    let next_index = |read: usize, total: Option<u64>| {
        let next = start + read as i64;
        (read == count as usize && total.is_none_or(|total| (next as u64) < total))
            .then(|| next.to_string())
    };
    match kind.as_str() {
        "string" => {
            value.value = Some(cell(&raw(&run(length("GET")).await?)));
            value.length = integer(&run(length("STRLEN")).await?).map(|n| n as u64);
        }
        "list" => {
            value.length = integer(&run(length("LLEN")).await?).map(|n| n as u64);
            let read = items(
                run(cmd("LRANGE")
                    .arg(&key)
                    .arg(start)
                    .arg(start + count as i64 - 1)
                    .clone())
                .await?,
            );
            value.cursor = next_index(read.len(), value.length);
            value.elements = read
                .iter()
                .enumerate()
                .map(|(at, item)| Element {
                    index: Some(start + at as i64),
                    value: cell(&raw(item)),
                    ..Element::default()
                })
                .collect();
        }
        "zset" => {
            value.length = integer(&run(length("ZCARD")).await?).map(|n| n as u64);
            let read = items(
                run(cmd("ZRANGE")
                    .arg(&key)
                    .arg(start)
                    .arg(start + count as i64 - 1)
                    .arg("WITHSCORES")
                    .clone())
                .await?,
            );
            value.elements = read
                .chunks(2)
                .map(|pair| Element {
                    score: pair
                        .get(1)
                        .and_then(text)
                        .and_then(|score| score.parse().ok()),
                    value: cell(&raw(&pair[0])),
                    ..Element::default()
                })
                .collect();
            value.cursor = next_index(value.elements.len(), value.length);
        }
        "set" | "hash" => {
            let (size, scan) = if kind == "set" {
                ("SCARD", "SSCAN")
            } else {
                ("HLEN", "HSCAN")
            };
            value.length = integer(&run(length(size)).await?).map(|n| n as u64);
            let reply = items(
                run(cmd(scan)
                    .arg(&key)
                    .arg(&scan_cursor)
                    .arg("COUNT")
                    .arg(count)
                    .clone())
                .await?,
            );
            value.cursor = reply.first().and_then(text).filter(|next| next != "0");
            let found = reply.into_iter().nth(1).map(items).unwrap_or_default();
            value.elements = if kind == "set" {
                found
                    .iter()
                    .map(|member| Element {
                        value: cell(&raw(member)),
                        ..Element::default()
                    })
                    .collect()
            } else {
                found
                    .chunks(2)
                    .map(|pair| Element {
                        field: Some(cell(&raw(&pair[0]))),
                        value: pair.get(1).map(|v| cell(&raw(v))).unwrap_or_default(),
                        ..Element::default()
                    })
                    .collect()
            };
        }
        "stream" => {
            value.length = integer(&run(length("XLEN")).await?).map(|n| n as u64);
            let from = params
                .cursor
                .as_deref()
                .map(|id| format!("({id}"))
                .unwrap_or_else(|| "-".into());
            let read = items(
                run(cmd("XRANGE")
                    .arg(&key)
                    .arg(&from)
                    .arg("+")
                    .arg("COUNT")
                    .arg(count)
                    .clone())
                .await?,
            );
            value.elements = read
                .into_iter()
                .map(|entry| {
                    let mut parts = items(entry).into_iter();
                    let id = parts.next().as_ref().and_then(text);
                    let fields = parts.next().map(items).unwrap_or_default();
                    let object: serde_json::Map<String, serde_json::Value> = fields
                        .chunks(2)
                        .map(|pair| {
                            let field = String::from_utf8_lossy(&raw(&pair[0])).into_owned();
                            let value = pair
                                .get(1)
                                .map(|v| serde_json::Value::from(cell(&raw(v))))
                                .unwrap_or_default();
                            (field, value)
                        })
                        .collect();
                    Element {
                        id,
                        value: Cell::typed(
                            nexo_driver_sdk::ValueKind::Json,
                            serde_json::Value::Object(object).to_string(),
                        ),
                        ..Element::default()
                    }
                })
                .collect();
            value.cursor = (value.elements.len() == count as usize)
                .then(|| value.elements.last().and_then(|e| e.id.clone()))
                .flatten();
        }
        "ReJSON-RL" => {
            value.kind = "json".into();
            value.value = Some(cell(&raw(&run(length("JSON.GET")).await?)));
        }
        _ => {}
    }
    Ok(value)
}
