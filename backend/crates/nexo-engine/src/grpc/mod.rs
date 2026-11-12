//! gRPC calls described by `.proto` source or by server reflection, with dynamic messages.

mod call;
mod codec;

use crate::egress::Policy;
pub use call::request;
pub(crate) use call::status_error;
pub(crate) use codec::DynamicCodec;
use codec::{from_json, to_json};
use hyper_util::rt::TokioIo;
use nexo_domain::{Error, Result};
use prost::Message as _;
use prost_reflect::{
    DescriptorPool, DynamicMessage, MessageDescriptor, MethodDescriptor, SerializeOptions,
    ServiceDescriptor,
};
use protox::file::{ChainFileResolver, File, FileResolver, GoogleFileResolver};
use serde_json::{Value, json};
use std::{
    net::SocketAddr,
    time::{Duration, Instant},
};
use tonic::{
    Status,
    client::Grpc,
    codec::{Codec, DecodeBuf, Decoder, EncodeBuf, Encoder},
    metadata::{AsciiMetadataValue, BinaryMetadataValue, MetadataKey, MetadataMap},
    transport::{Certificate, Channel, ClientTlsConfig, Endpoint},
};

const MAX_PROTO: usize = 2 * 1024 * 1024;
const MAX_STREAM_MESSAGES: usize = 1000;
const SOURCE: &str = "request.proto";

fn invalid(message: impl Into<String>) -> Error {
    Error::Validation(message.into())
}

/// Resolves the user's source and the bundled `google/protobuf/*` files, nothing else.
struct Source(String);
impl FileResolver for Source {
    fn open_file(&self, name: &str) -> std::result::Result<File, protox::Error> {
        if name == SOURCE {
            File::from_source(name, &self.0)
        } else {
            Err(protox::Error::file_not_found(name))
        }
    }
}
pub fn compile(source: &str) -> Result<DescriptorPool> {
    let mut resolver = ChainFileResolver::new();
    resolver.add(Source(source.to_string()));
    resolver.add(GoogleFileResolver::new());
    let mut compiler = protox::Compiler::with_file_resolver(resolver);
    compiler.include_imports(true);
    compiler.open_file(SOURCE).map_err(|error| {
        if error.is_file_not_found() {
            invalid(format!(
                "{error}; inline it into the definition (only google/protobuf types are built in)"
            ))
        } else {
            invalid(error.to_string())
        }
    })?;
    Ok(compiler.descriptor_pool())
}

/// The method of the service the payload names.
fn method_of(service: &ServiceDescriptor, payload: &Value) -> Result<MethodDescriptor> {
    let name = payload["method"].as_str().unwrap_or("");
    service
        .methods()
        .find(|method| method.name() == name)
        .ok_or_else(|| {
            invalid(format!(
                "gRPC method not found. Available: {}",
                service
                    .methods()
                    .map(|m| m.name().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        })
}

fn selected_service(payload: &Value) -> Option<&str> {
    payload["service"]
        .as_str()
        .map(str::trim)
        .filter(|name| !name.is_empty())
}

/// The services and, for each, its methods and how they stream.
fn discovery(pool: &DescriptorPool, services: &[String]) -> Value {
    let methods: serde_json::Map<String, Value> = services
        .iter()
        .filter_map(|name| pool.get_service_by_name(name))
        .map(|service| {
            let methods: Vec<Value> = service
                .methods()
                .map(|method| {
                    json!({
                        "name": method.name(),
                        "input": method.input().full_name(),
                        "output": method.output().full_name(),
                        "clientStreaming": method.is_client_streaming(),
                        "serverStreaming": method.is_server_streaming(),
                    })
                })
                .collect();
            (service.full_name().to_string(), Value::Array(methods))
        })
        .collect();
    json!({"services": services, "methods": methods})
}

fn source_chain(error: &dyn std::error::Error) -> String {
    let mut message = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        message = format!("{message}: {cause}");
        source = cause.source();
    }
    message
}

#[cfg(test)]
mod tests;
