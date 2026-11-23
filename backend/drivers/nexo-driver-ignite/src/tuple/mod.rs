//! Ignite's `BinaryTuple`, the form of a row and of the arguments of a statement: a header
//! byte (its two low bits say the size of an offset: 1, 2 or 4 bytes), the table of the
//! offsets where each element ends, counted from the start of the values and little-endian,
//! then the values. An empty element is null; a text or bytes that would read as empty, or
//! start with `0x80`, go after one `0x80`.
use crate::msgpack::broken;
use nexo_driver_sdk::Result;

/// What opens a text or bytes that would otherwise be empty or start with this byte.
const EMPTY: u8 = 0x80;

/// The elements of a tuple, read in place.
pub struct Tuple<'a> {
    values: &'a [u8],
    ends: Vec<usize>,
}

impl<'a> Tuple<'a> {
    /// The `count` elements of a tuple.
    pub fn parse(bytes: &'a [u8], count: usize) -> Result<Self> {
        let flags = *bytes.first().ok_or_else(|| broken("an empty row"))?;
        let size = match flags & 0b11 {
            0 => 1,
            1 => 2,
            2 => 4,
            _ => return Err(broken("the offsets of a row")),
        };
        let table_end = count
            .checked_mul(size)
            .and_then(|table| table.checked_add(1))
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| broken("a row cut short"))?;
        let values = &bytes[table_end..];
        let mut ends = Vec::with_capacity(count);
        for entry in bytes[1..table_end].chunks_exact(size) {
            let mut word = [0u8; 4];
            word[..size].copy_from_slice(entry);
            let end = u32::from_le_bytes(word) as usize;
            if end > values.len() || ends.last().is_some_and(|last| end < *last) {
                return Err(broken("the offsets of a row"));
            }
            ends.push(end);
        }
        Ok(Self { values, ends })
    }
    /// The bytes of an element; `None` when it is null.
    pub fn get(&self, index: usize) -> Option<&'a [u8]> {
        let end = *self.ends.get(index)?;
        let start = if index == 0 { 0 } else { self.ends[index - 1] };
        (end > start).then(|| &self.values[start..end])
    }
}

/// The bytes of a text or a binary element, without the `0x80` that may open them.
pub fn varlen(bytes: &[u8]) -> &[u8] {
    match bytes.first() {
        Some(&EMPTY) => &bytes[1..],
        _ => bytes,
    }
}

/// Writes a tuple, element by element.
#[derive(Debug, Default)]
pub struct Builder {
    values: Vec<u8>,
    ends: Vec<usize>,
}

impl Builder {
    fn end(&mut self) -> &mut Self {
        self.ends.push(self.values.len());
        self
    }
    pub fn null(&mut self) -> &mut Self {
        self.end()
    }
    /// An element of its own bytes, as they are.
    pub fn raw(&mut self, bytes: &[u8]) -> &mut Self {
        self.values.extend(bytes);
        self.end()
    }
    /// An integer in the fewest bytes that hold it, as Ignite writes one.
    pub fn int(&mut self, value: i64) -> &mut Self {
        if let Ok(byte) = i8::try_from(value) {
            self.values.push(byte as u8);
        } else if let Ok(short) = i16::try_from(value) {
            self.values.extend(short.to_le_bytes());
        } else if let Ok(int) = i32::try_from(value) {
            self.values.extend(int.to_le_bytes());
        } else {
            self.values.extend(value.to_le_bytes());
        }
        self.end()
    }
    /// A text or bytes, after `0x80` when they would read as empty or start with it.
    pub fn varlen(&mut self, bytes: &[u8]) -> &mut Self {
        if bytes.first().is_none_or(|first| *first == EMPTY) {
            self.values.push(EMPTY);
        }
        self.values.extend(bytes);
        self.end()
    }
    pub fn build(&self) -> Vec<u8> {
        let size: usize = match self.values.len() {
            0..=0xff => 1,
            0x100..=0xffff => 2,
            _ => 4,
        };
        let mut bytes = Vec::with_capacity(1 + self.ends.len() * size + self.values.len());
        bytes.push(size.trailing_zeros() as u8);
        for end in &self.ends {
            bytes.extend(&(*end as u32).to_le_bytes()[..size]);
        }
        bytes.extend(&self.values);
        bytes
    }
}

#[cfg(test)]
mod tests;
