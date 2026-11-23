//! Thrift's binary protocol, the part HiveServer2 uses: a call is a message with its name and
//! one struct, and its answer a message whose struct holds the result in field 0. Written by
//! hand from `TCLIService.thrift` (Hive 4) instead of generated: the driver needs a dozen of
//! its structs, read here as trees of fields by their numbers.
mod builder;
pub use builder::Builder;

use nexo_driver_sdk::{DriverError, Result};
use std::collections::BTreeMap;

/// The type of a field, as the protocol writes it.
mod kind {
    pub const STOP: u8 = 0;
    pub const BOOL: u8 = 2;
    pub const BYTE: u8 = 3;
    pub const DOUBLE: u8 = 4;
    pub const I16: u8 = 6;
    pub const I32: u8 = 8;
    pub const I64: u8 = 10;
    pub const STRING: u8 = 11;
    pub const STRUCT: u8 = 12;
    pub const MAP: u8 = 13;
    pub const SET: u8 = 14;
    pub const LIST: u8 = 15;
}

/// A value of the protocol.
#[derive(Debug, Clone, PartialEq)]
pub enum Thrift {
    Bool(bool),
    Byte(i8),
    I16(i16),
    I32(i32),
    I64(i64),
    Double(f64),
    /// A string or binary: the protocol does not tell them apart.
    Bytes(Vec<u8>),
    Struct(Fields),
    Map(u8, u8, Vec<(Thrift, Thrift)>),
    List(u8, Vec<Thrift>),
}

/// The fields of a struct, by their number.
pub type Fields = BTreeMap<i16, Thrift>;

impl Thrift {
    pub fn text(text: &str) -> Self {
        Self::Bytes(text.as_bytes().to_vec())
    }
    fn kind(&self) -> u8 {
        match self {
            Self::Bool(_) => kind::BOOL,
            Self::Byte(_) => kind::BYTE,
            Self::I16(_) => kind::I16,
            Self::I32(_) => kind::I32,
            Self::I64(_) => kind::I64,
            Self::Double(_) => kind::DOUBLE,
            Self::Bytes(_) => kind::STRING,
            Self::Struct(_) => kind::STRUCT,
            Self::Map(..) => kind::MAP,
            Self::List(..) => kind::LIST,
        }
    }
    pub fn field(&self, id: i16) -> Option<&Thrift> {
        match self {
            Self::Struct(fields) => fields.get(&id),
            _ => None,
        }
    }
    pub fn i32(&self) -> Option<i32> {
        match self {
            Self::I32(value) => Some(*value),
            _ => None,
        }
    }
    pub fn bool(&self) -> Option<bool> {
        match self {
            Self::Bool(value) => Some(*value),
            _ => None,
        }
    }
    pub fn bytes(&self) -> Option<&[u8]> {
        match self {
            Self::Bytes(value) => Some(value),
            _ => None,
        }
    }
    pub fn string(&self) -> Option<String> {
        self.bytes()
            .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
    }
    pub fn list(&self) -> &[Thrift] {
        match self {
            Self::List(_, items) => items,
            _ => &[],
        }
    }
}

/// A call: the message `name` with its arguments in field 1, as `TCLIService` takes them.
pub fn call(name: &str, sequence: i32, request: Thrift) -> Vec<u8> {
    let mut out = Vec::new();
    // Strict binary protocol, version 1, message type CALL (1).
    out.extend_from_slice(&(0x8001_0001u32 as i32).to_be_bytes());
    write_bytes(&mut out, name.as_bytes());
    out.extend_from_slice(&sequence.to_be_bytes());
    write_value(&mut out, &Builder::new().set(1, request).build());
    out
}

/// The answer to a call: its result (field 0 of the reply's struct), or the exception the
/// server sent instead.
pub fn reply(bytes: &[u8], name: &str) -> Result<Thrift> {
    let mut reader = Reader { bytes, at: 0 };
    let header = reader.i32()? as u32;
    if header & 0xffff_0000 != 0x8001_0000 {
        return Err(DriverError::network(
            "The server did not answer in Thrift: check the port and the HTTP path",
        ));
    }
    let message = header & 0xff;
    let answered = String::from_utf8_lossy(reader.take_bytes()?).into_owned();
    reader.i32()?;
    let body = reader.value(kind::STRUCT)?;
    // An exception of the application (type 3): its message in field 1.
    if message == 3 {
        let text = body.field(1).and_then(Thrift::string).unwrap_or_default();
        return Err(DriverError::invalid(format!(
            "HiveServer2 refused {name}: {text}"
        )));
    }
    if answered != name {
        return Err(DriverError::network(format!(
            "HiveServer2 answered {answered} to {name}"
        )));
    }
    body.field(0)
        .cloned()
        .ok_or_else(|| DriverError::network(format!("HiveServer2 sent no result for {name}")))
}

fn write_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as i32).to_be_bytes());
    out.extend_from_slice(bytes);
}

fn write_value(out: &mut Vec<u8>, value: &Thrift) {
    match value {
        Thrift::Bool(value) => out.push(u8::from(*value)),
        Thrift::Byte(value) => out.push(*value as u8),
        Thrift::I16(value) => out.extend_from_slice(&value.to_be_bytes()),
        Thrift::I32(value) => out.extend_from_slice(&value.to_be_bytes()),
        Thrift::I64(value) => out.extend_from_slice(&value.to_be_bytes()),
        Thrift::Double(value) => out.extend_from_slice(&value.to_bits().to_be_bytes()),
        Thrift::Bytes(bytes) => write_bytes(out, bytes),
        Thrift::Struct(fields) => {
            for (id, field) in fields {
                out.push(field.kind());
                out.extend_from_slice(&id.to_be_bytes());
                write_value(out, field);
            }
            out.push(kind::STOP);
        }
        Thrift::Map(key, value, entries) => {
            out.push(*key);
            out.push(*value);
            out.extend_from_slice(&(entries.len() as i32).to_be_bytes());
            for (k, v) in entries {
                write_value(out, k);
                write_value(out, v);
            }
        }
        Thrift::List(item, items) => {
            out.push(*item);
            out.extend_from_slice(&(items.len() as i32).to_be_bytes());
            for item in items {
                write_value(out, item);
            }
        }
    }
}

/// The most a container may say it holds: more is a broken answer, not a big one.
const MAX_ITEMS: i32 = 10_000_000;
/// How deep structs may nest in an answer.
const MAX_DEPTH: usize = 64;

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

fn broken() -> DriverError {
    DriverError::network("HiveServer2 sent an answer that is cut or broken")
}

impl Reader<'_> {
    fn take(&mut self, count: usize) -> Result<&[u8]> {
        let end = self.at.checked_add(count).ok_or_else(broken)?;
        let slice = self.bytes.get(self.at..end).ok_or_else(broken)?;
        self.at = end;
        Ok(slice)
    }
    fn byte(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn i16(&mut self) -> Result<i16> {
        Ok(i16::from_be_bytes(
            self.take(2)?.try_into().map_err(|_| broken())?,
        ))
    }
    fn i32(&mut self) -> Result<i32> {
        Ok(i32::from_be_bytes(
            self.take(4)?.try_into().map_err(|_| broken())?,
        ))
    }
    fn i64(&mut self) -> Result<i64> {
        Ok(i64::from_be_bytes(
            self.take(8)?.try_into().map_err(|_| broken())?,
        ))
    }
    fn count(&mut self) -> Result<usize> {
        let count = self.i32()?;
        if !(0..=MAX_ITEMS).contains(&count) {
            return Err(broken());
        }
        Ok(count as usize)
    }
    fn take_bytes(&mut self) -> Result<&[u8]> {
        let length = self.count()?;
        self.take(length)
    }
    fn value(&mut self, kind: u8) -> Result<Thrift> {
        self.value_at(kind, 0)
    }
    fn value_at(&mut self, kind: u8, depth: usize) -> Result<Thrift> {
        if depth > MAX_DEPTH {
            return Err(broken());
        }
        Ok(match kind {
            kind::BOOL => Thrift::Bool(self.byte()? != 0),
            kind::BYTE => Thrift::Byte(self.byte()? as i8),
            kind::I16 => Thrift::I16(self.i16()?),
            kind::I32 => Thrift::I32(self.i32()?),
            kind::I64 => Thrift::I64(self.i64()?),
            kind::DOUBLE => Thrift::Double(f64::from_bits(self.i64()? as u64)),
            kind::STRING => Thrift::Bytes(self.take_bytes()?.to_vec()),
            kind::STRUCT => {
                let mut fields = Fields::new();
                loop {
                    let field = self.byte()?;
                    if field == kind::STOP {
                        break;
                    }
                    let id = self.i16()?;
                    fields.insert(id, self.value_at(field, depth + 1)?);
                }
                Thrift::Struct(fields)
            }
            kind::MAP => {
                let (key, value) = (self.byte()?, self.byte()?);
                let count = self.count()?;
                let mut entries = Vec::with_capacity(count.min(1024));
                for _ in 0..count {
                    let k = self.value_at(key, depth + 1)?;
                    let v = self.value_at(value, depth + 1)?;
                    entries.push((k, v));
                }
                Thrift::Map(key, value, entries)
            }
            kind::LIST | kind::SET => {
                let item = self.byte()?;
                let count = self.count()?;
                let mut items = Vec::with_capacity(count.min(1024));
                for _ in 0..count {
                    items.push(self.value_at(item, depth + 1)?);
                }
                Thrift::List(item, items)
            }
            _ => return Err(broken()),
        })
    }
}

#[cfg(test)]
mod tests;
