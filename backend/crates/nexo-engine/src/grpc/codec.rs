//! Messages of methods known only at run time, converted to and from JSON.
use super::*;

/// Encodes and decodes messages described at run time.
#[derive(Clone)]
pub(crate) struct DynamicCodec(pub(crate) MessageDescriptor);
pub(crate) struct DynamicEncoder;
pub(crate) struct DynamicDecoder(pub(super) MessageDescriptor);
impl Codec for DynamicCodec {
    type Encode = DynamicMessage;
    type Decode = DynamicMessage;
    type Encoder = DynamicEncoder;
    type Decoder = DynamicDecoder;
    fn encoder(&mut self) -> Self::Encoder {
        DynamicEncoder
    }
    fn decoder(&mut self) -> Self::Decoder {
        DynamicDecoder(self.0.clone())
    }
}
impl Encoder for DynamicEncoder {
    type Item = DynamicMessage;
    type Error = Status;
    fn encode(
        &mut self,
        item: DynamicMessage,
        dst: &mut EncodeBuf<'_>,
    ) -> std::result::Result<(), Status> {
        item.encode(dst)
            .map_err(|error| Status::internal(error.to_string()))
    }
}
impl Decoder for DynamicDecoder {
    type Item = DynamicMessage;
    type Error = Status;
    fn decode(
        &mut self,
        src: &mut DecodeBuf<'_>,
    ) -> std::result::Result<Option<DynamicMessage>, Status> {
        DynamicMessage::decode(self.0.clone(), src)
            .map(Some)
            .map_err(|error| Status::internal(error.to_string()))
    }
}

pub(super) fn to_json(message: &DynamicMessage) -> Value {
    let options = SerializeOptions::new()
        .use_proto_field_name(true)
        .skip_default_fields(false)
        .stringify_64_bit_integers(true);
    message
        .serialize_with_options(serde_json::value::Serializer, &options)
        .unwrap_or(Value::Null)
}
pub(super) fn from_json(descriptor: &MessageDescriptor, value: &Value) -> Result<DynamicMessage> {
    let value = if value.is_null() {
        json!({})
    } else {
        value.clone()
    };
    let options = prost_reflect::DeserializeOptions::new().deny_unknown_fields(false);
    DynamicMessage::deserialize_with_options(descriptor.clone(), value, &options).map_err(|error| {
        invalid(format!(
            "The request message does not match {}: {error}",
            descriptor.full_name()
        ))
    })
}
