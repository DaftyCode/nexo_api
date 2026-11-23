//! The part of MessagePack the client protocol of Ignite 3 uses: nil, booleans, integers,
//! strings, binaries and the UUID extension (type 3), plus skipping any other value. Written
//! by hand: integers go in their smallest form, as the Java client's `ClientMessagePacker`
//! writes them, and any form of an integer is read.
use nexo_driver_sdk::{DriverError, Result};

/// The extension type of a UUID (`ClientMsgPackType.UUID`).
const UUID: u8 = 3;
/// How deep arrays and maps may nest in a value that is skipped.
const DEPTH: usize = 32;

/// An answer the driver cannot read.
pub fn broken(what: &str) -> DriverError {
    DriverError::internal(format!(
        "Ignite answered a message this driver cannot read ({what})"
    ))
}

#[derive(Debug, Default)]
pub struct Writer {
    bytes: Vec<u8>,
}

impl Writer {
    pub fn nil(&mut self) -> &mut Self {
        self.bytes.push(0xc0);
        self
    }
    pub fn bool(&mut self, value: bool) -> &mut Self {
        self.bytes.push(if value { 0xc3 } else { 0xc2 });
        self
    }
    pub fn int(&mut self, value: i64) -> &mut Self {
        let bytes = &mut self.bytes;
        match value {
            // Positive and negative fixint.
            -32..=127 => bytes.push(value as u8),
            128..=0xff => bytes.extend([0xcc, value as u8]),
            0x100..=0xffff => {
                bytes.push(0xcd);
                bytes.extend((value as u16).to_be_bytes());
            }
            0x1_0000..=0xffff_ffff => {
                bytes.push(0xce);
                bytes.extend((value as u32).to_be_bytes());
            }
            0x1_0000_0000.. => {
                bytes.push(0xcf);
                bytes.extend((value as u64).to_be_bytes());
            }
            -128..=-33 => bytes.extend([0xd0, value as i8 as u8]),
            -32_768..=-129 => {
                bytes.push(0xd1);
                bytes.extend((value as i16).to_be_bytes());
            }
            -2_147_483_648..=-32_769 => {
                bytes.push(0xd2);
                bytes.extend((value as i32).to_be_bytes());
            }
            _ => {
                bytes.push(0xd3);
                bytes.extend(value.to_be_bytes());
            }
        }
        self
    }
    pub fn str(&mut self, value: &str) -> &mut Self {
        let length = value.len();
        match length {
            0..=31 => self.bytes.push(0xa0 | length as u8),
            32..=0xff => self.bytes.extend([0xd9, length as u8]),
            0x100..=0xffff => {
                self.bytes.push(0xda);
                self.bytes.extend((length as u16).to_be_bytes());
            }
            _ => {
                self.bytes.push(0xdb);
                self.bytes.extend((length as u32).to_be_bytes());
            }
        }
        self.bytes.extend(value.as_bytes());
        self
    }
    pub fn bin(&mut self, value: &[u8]) -> &mut Self {
        let length = value.len();
        match length {
            0..=0xff => self.bytes.extend([0xc4, length as u8]),
            0x100..=0xffff => {
                self.bytes.push(0xc5);
                self.bytes.extend((length as u16).to_be_bytes());
            }
            _ => {
                self.bytes.push(0xc6);
                self.bytes.extend((length as u32).to_be_bytes());
            }
        }
        self.bytes.extend(value);
        self
    }
    /// Values written before, as they are.
    pub fn raw(&mut self, bytes: &[u8]) -> &mut Self {
        self.bytes.extend(bytes);
        self
    }
    pub fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }
}

/// Reads the values of a message one after another.
pub struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, at: 0 }
    }
    fn take(&mut self, count: usize) -> Result<&'a [u8]> {
        let end = self
            .at
            .checked_add(count)
            .filter(|end| *end <= self.bytes.len())
            .ok_or_else(|| broken("a message cut short"))?;
        let taken = &self.bytes[self.at..end];
        self.at = end;
        Ok(taken)
    }
    fn byte(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn array<const N: usize>(&mut self) -> Result<[u8; N]> {
        let mut array = [0; N];
        array.copy_from_slice(self.take(N)?);
        Ok(array)
    }
    fn length(&mut self, size: usize) -> Result<usize> {
        Ok(match size {
            1 => usize::from(self.byte()?),
            2 => usize::from(u16::from_be_bytes(self.array()?)),
            _ => u32::from_be_bytes(self.array()?) as usize,
        })
    }
    /// What is left to read.
    pub fn rest(&self) -> &'a [u8] {
        &self.bytes[self.at..]
    }
    /// Reads a nil when it is the next value.
    pub fn nil(&mut self) -> Result<bool> {
        let nil = *self
            .bytes
            .get(self.at)
            .ok_or_else(|| broken("a message cut short"))?
            == 0xc0;
        if nil {
            self.at += 1;
        }
        Ok(nil)
    }
    pub fn bool(&mut self) -> Result<bool> {
        match self.byte()? {
            0xc2 => Ok(false),
            0xc3 => Ok(true),
            _ => Err(broken("a boolean")),
        }
    }
    pub fn int(&mut self) -> Result<i64> {
        let marker = self.byte()?;
        Ok(match marker {
            0x00..=0x7f => i64::from(marker),
            0xe0..=0xff => i64::from(marker as i8),
            0xcc => i64::from(self.byte()?),
            0xcd => i64::from(u16::from_be_bytes(self.array()?)),
            0xce => i64::from(u32::from_be_bytes(self.array()?)),
            0xcf => i64::try_from(u64::from_be_bytes(self.array()?))
                .map_err(|_| broken("an integer too large"))?,
            0xd0 => i64::from(self.byte()? as i8),
            0xd1 => i64::from(i16::from_be_bytes(self.array()?)),
            0xd2 => i64::from(i32::from_be_bytes(self.array()?)),
            0xd3 => i64::from_be_bytes(self.array()?),
            _ => return Err(broken("an integer")),
        })
    }
    pub fn str(&mut self) -> Result<String> {
        let marker = self.byte()?;
        let length = match marker {
            0xa0..=0xbf => usize::from(marker & 0x1f),
            0xd9 => self.length(1)?,
            0xda => self.length(2)?,
            0xdb => self.length(4)?,
            _ => return Err(broken("a text")),
        };
        String::from_utf8(self.take(length)?.to_vec()).map_err(|_| broken("a text"))
    }
    pub fn opt_str(&mut self) -> Result<Option<String>> {
        if self.nil()? {
            return Ok(None);
        }
        self.str().map(Some)
    }
    pub fn bin(&mut self) -> Result<&'a [u8]> {
        let length = match self.byte()? {
            0xc4 => self.length(1)?,
            0xc5 => self.length(2)?,
            0xc6 => self.length(4)?,
            _ => return Err(broken("a binary")),
        };
        self.take(length)
    }
    /// A UUID, as Ignite writes it: its two halves, each in little-endian order.
    pub fn uuid(&mut self) -> Result<[u8; 16]> {
        if self.byte()? != 0xd8 || self.byte()? != UUID {
            return Err(broken("a UUID"));
        }
        self.array()
    }
    /// Skips the next value, whatever it is.
    pub fn skip(&mut self) -> Result<()> {
        self.skip_within(DEPTH)
    }
    fn skip_within(&mut self, depth: usize) -> Result<()> {
        let marker = self.byte()?;
        let (items, bytes) = match marker {
            0x00..=0x7f | 0xe0..=0xff | 0xc0 | 0xc2 | 0xc3 => (0, 0),
            0x80..=0x8f => (usize::from(marker & 0x0f) * 2, 0),
            0x90..=0x9f => (usize::from(marker & 0x0f), 0),
            0xa0..=0xbf => (0, usize::from(marker & 0x1f)),
            0xc4 | 0xd9 => (0, self.length(1)?),
            0xc5 | 0xda => (0, self.length(2)?),
            0xc6 | 0xdb => (0, self.length(4)?),
            // Extensions: the length, then the type.
            0xc7 => (0, self.length(1)? + 1),
            0xc8 => (0, self.length(2)? + 1),
            0xc9 => (0, self.length(4)? + 1),
            0xcc | 0xd0 => (0, 1),
            0xcd | 0xd1 | 0xd4 => (0, 2),
            0xd5 => (0, 3),
            0xca | 0xce | 0xd2 => (0, 4),
            0xd6 => (0, 5),
            0xcb | 0xcf | 0xd3 => (0, 8),
            0xd7 => (0, 9),
            0xd8 => (0, 17),
            0xdc => (self.length(2)?, 0),
            0xdd => (self.length(4)?, 0),
            0xde => (self.length(2)? * 2, 0),
            0xdf => (self.length(4)? * 2, 0),
            _ => return Err(broken("a value")),
        };
        if items > 0 && depth == 0 {
            return Err(broken("values nested too deep"));
        }
        for _ in 0..items {
            self.skip_within(depth - 1)?;
        }
        self.take(bytes).map(|_| ())
    }
}

/// A UUID as text, from the bytes Ignite writes.
pub fn uuid_text(bytes: &[u8]) -> String {
    let mut ordered = [0u8; 16];
    for (at, byte) in bytes.iter().take(16).enumerate() {
        // Each half is little-endian: its last byte comes first in the text.
        ordered[(at / 8) * 8 + 7 - at % 8] = *byte;
    }
    let hex: String = ordered.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// The bytes Ignite writes of a UUID written as text.
pub fn uuid_bytes(text: &str) -> Option<[u8; 16]> {
    let hex: Vec<u8> = text.bytes().filter(|byte| *byte != b'-').collect();
    if hex.len() != 32 || text.len() != 36 {
        return None;
    }
    let mut bytes = [0u8; 16];
    for at in 0..16 {
        let pair = std::str::from_utf8(&hex[at * 2..at * 2 + 2]).ok()?;
        bytes[(at / 8) * 8 + 7 - at % 8] = u8::from_str_radix(pair, 16).ok()?;
    }
    Some(bytes)
}

#[cfg(test)]
mod tests;
