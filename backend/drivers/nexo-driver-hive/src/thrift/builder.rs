use super::{Fields, Thrift};

/// A struct built field by field.
#[derive(Default)]
pub struct Builder(Fields);
impl Builder {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn set(mut self, id: i16, value: Thrift) -> Self {
        self.0.insert(id, value);
        self
    }
    pub fn some(self, id: i16, value: Option<Thrift>) -> Self {
        match value {
            Some(value) => self.set(id, value),
            None => self,
        }
    }
    pub fn build(self) -> Thrift {
        Thrift::Struct(self.0)
    }
}
