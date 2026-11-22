//! Changes to a key from its sheet: its value or an element by its type, its name, its
//! expiry, or the key itself. Bytes are written as they come, so a binary value is never
//! turned into text.
use crate::{
    connection::{Conn, failure},
    reply::{bytes, integer, text},
};
use nexo_driver_sdk::{
    DriverError, Result, Value as Cell,
    keyvalue::{WriteAction, WriteParams, Written},
};
use redis::{Cmd, cmd};

fn needs<'a>(value: &'a Option<Cell>, what: &str) -> Result<&'a Cell> {
    value
        .as_ref()
        .ok_or_else(|| DriverError::invalid(format!("Write the {what}")))
}

/// The commands of a change, in order.
fn commands(kind: &str, key: &[u8], params: &WriteParams) -> Result<Vec<Cmd>> {
    let value = || needs(&params.value, "value").and_then(bytes);
    let field = || needs(&params.field, "field").and_then(bytes);
    let one = |name: &str| -> Cmd { cmd(name).arg(key).clone() };
    Ok(match (&params.action, kind) {
        (WriteAction::Set, "string" | "none")
            if params.kind.as_deref().is_none_or(|k| k == "string") =>
        {
            // A new value keeps the key's expiry.
            let mut set = one("SET");
            set.arg(value()?);
            if kind == "string" {
                set.arg("KEEPTTL");
            }
            vec![set]
        }
        (WriteAction::Set, "json" | "ReJSON-RL") | (WriteAction::Set, "none")
            if params.kind.as_deref() == Some("json") =>
        {
            vec![one("JSON.SET").arg("$").arg(value()?).clone()]
        }
        // A new collection, with its first element.
        (WriteAction::Set, "none") => {
            let put = WriteParams {
                action: WriteAction::Put,
                ..params.clone()
            };
            let kind = params.kind.as_deref().unwrap_or("string");
            return commands(kind, key, &put);
        }
        (WriteAction::Set, other) => {
            return Err(DriverError::invalid(format!(
                "A {other} changes element by element"
            )));
        }
        (WriteAction::Rename, _) => {
            let to = bytes(needs(&params.to, "new name")?)?;
            vec![one("RENAMENX").arg(to).clone()]
        }
        (WriteAction::Expire, _) => match params.ttl_ms {
            Some(ms) if ms > 0 => vec![one("PEXPIRE").arg(ms).clone()],
            Some(_) => return Err(DriverError::invalid("An expiry is more than 0 ms")),
            None => vec![one("PERSIST")],
        },
        (WriteAction::Delete, _) => vec![one("UNLINK")],
        (WriteAction::Put, "hash") => vec![one("HSET").arg(field()?).arg(value()?).clone()],
        (WriteAction::Put, "list") => match params.index {
            Some(index) => vec![one("LSET").arg(index).arg(value()?).clone()],
            None => vec![one("RPUSH").arg(value()?).clone()],
        },
        (WriteAction::Put, "set") => {
            let mut done = Vec::new();
            // Changing a member: the old one goes, the new one comes.
            if let Some(old) = &params.field {
                done.push(one("SREM").arg(bytes(old)?).clone());
            }
            done.push(one("SADD").arg(value()?).clone());
            done
        }
        (WriteAction::Put, "zset") => {
            let score = params
                .score
                .ok_or_else(|| DriverError::invalid("Write the score"))?;
            let mut done = Vec::new();
            if let Some(old) = &params.field {
                done.push(one("ZREM").arg(bytes(old)?).clone());
            }
            done.push(one("ZADD").arg(score).arg(value()?).clone());
            done
        }
        (WriteAction::Put, "stream") => {
            if params.fields.is_empty() {
                return Err(DriverError::invalid("An entry has at least one field"));
            }
            let mut add = one("XADD");
            add.arg("*");
            for (field, value) in &params.fields {
                add.arg(bytes(field)?).arg(bytes(value)?);
            }
            vec![add]
        }
        (WriteAction::Remove, "hash") => vec![one("HDEL").arg(field()?).clone()],
        (WriteAction::Remove, "list") => vec![one("LREM").arg(1).arg(value()?).clone()],
        (WriteAction::Remove, "set") => vec![one("SREM").arg(value()?).clone()],
        (WriteAction::Remove, "zset") => vec![one("ZREM").arg(value()?).clone()],
        (WriteAction::Remove, "stream") => {
            let id = text_of(needs(&params.field, "entry id")?)?;
            vec![one("XDEL").arg(id).clone()]
        }
        (_, other) => {
            return Err(DriverError::invalid(format!(
                "Nexo does not change a {other} element by element: use the console"
            )));
        }
    })
}

fn text_of(value: &Cell) -> Result<String> {
    String::from_utf8(bytes(value)?).map_err(|_| DriverError::invalid("An id is text"))
}

/// Applies a change to a key.
pub(crate) async fn write(connection: &Conn, params: WriteParams) -> Result<Written> {
    let key = bytes(&params.key)?;
    let kind = text(
        &connection
            .run(cmd("TYPE").arg(&key))
            .await
            .map_err(failure)?,
    )
    .unwrap_or_default();
    if kind == "none" && params.action != WriteAction::Set {
        return Err(DriverError::invalid(
            "The key does not exist (or has just expired)",
        ));
    }
    // A type says the key is new: an existing one is never overwritten.
    if kind != "none" && params.action == WriteAction::Set && params.kind.is_some() {
        return Err(DriverError::invalid("A key with that name already exists"));
    }
    let mut last = redis::Value::Nil;
    for command in commands(&kind, &key, &params)? {
        last = connection.run(&command).await.map_err(failure)?;
    }
    if params.action == WriteAction::Rename && integer(&last) == Some(0) {
        return Err(DriverError::invalid(
            "A key with the new name already exists",
        ));
    }
    Ok(Written {
        key: if params.action == WriteAction::Rename {
            params.to.unwrap_or_default()
        } else {
            params.key
        },
        done: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn written(kind: &str, params: WriteParams) -> Vec<Vec<u8>> {
        commands(kind, b"k", &params)
            .unwrap()
            .iter()
            .map(|command| command.get_packed_command())
            .collect()
    }

    #[test]
    fn each_change_is_the_command_of_its_type() {
        let set = WriteParams {
            value: Some(Cell::bytes(&[0, 255])),
            ..WriteParams::default()
        };
        let packed = written("string", set.clone());
        assert!(packed[0].windows(2).any(|pair| pair == [0, 255]));
        assert!(String::from_utf8_lossy(&packed[0]).contains("KEEPTTL"));
        assert!(!String::from_utf8_lossy(&written("none", set)[0]).contains("KEEPTTL"));
        let zadd = WriteParams {
            action: WriteAction::Put,
            value: Some(Cell::Text("m".into())),
            field: Some(Cell::Text("old".into())),
            score: Some(1.5),
            ..WriteParams::default()
        };
        let packed = written("zset", zadd);
        assert!(String::from_utf8_lossy(&packed[0]).contains("ZREM"));
        assert!(String::from_utf8_lossy(&packed[1]).contains("1.5"));
        let new_hash = WriteParams {
            kind: Some("hash".into()),
            value: Some(Cell::Text("v".into())),
            field: Some(Cell::Text("f".into())),
            ..WriteParams::default()
        };
        assert!(String::from_utf8_lossy(&written("none", new_hash)[0]).contains("HSET"));
        let persist = WriteParams {
            action: WriteAction::Expire,
            ..WriteParams::default()
        };
        assert!(String::from_utf8_lossy(&written("list", persist)[0]).contains("PERSIST"));
        let wrong = WriteParams {
            value: Some(Cell::Text("v".into())),
            ..WriteParams::default()
        };
        assert!(commands("hash", b"k", &wrong).is_err());
    }
}
