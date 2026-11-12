//! gRPC server reflection (`grpc.reflection.v1` and the older `v1alpha` many servers still
//! use): the services a server offers and the descriptors of their files, so methods can be
//! called without pasting a `.proto`.
//!
//! The protocol is a bidirectional stream; each question is sent on a stream of its own and the
//! first answer read, which every server implementation accepts. `reflection.proto` is built in
//! and spoken with dynamic messages, so no generated code is needed.

mod client;

#[cfg(test)]
use client::list_services;

use crate::grpc::{DynamicCodec, status_error};
pub use client::Reflection;
#[cfg(test)]
use client::{add, file_descriptors, message_field};
use nexo_domain::{Error, Result};
use prost::Message as _;
use prost_reflect::{
    DescriptorPool, DynamicMessage, ReflectMessage, Value as Field,
    prost_types::{FileDescriptorProto, FileDescriptorSet},
};
use protox::file::{ChainFileResolver, File, FileResolver, GoogleFileResolver};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::OnceLock,
    time::Duration,
};
use tonic::{Code, Status, client::Grpc, metadata::MetadataMap, transport::Channel};

/// `reflection.proto`, the same for both versions but its package.
const REFLECTION: &str = r#"
syntax = "proto3";
package PACKAGE;
service ServerReflection {
  rpc ServerReflectionInfo(stream ServerReflectionRequest) returns (stream ServerReflectionResponse);
}
message ServerReflectionRequest {
  string host = 1;
  oneof message_request {
    string file_by_filename = 3;
    string file_containing_symbol = 4;
    ExtensionRequest file_containing_extension = 5;
    string all_extension_numbers_of_type = 6;
    string list_services = 7;
  }
}
message ExtensionRequest {
  string containing_type = 1;
  int32 extension_number = 2;
}
message ServerReflectionResponse {
  string valid_host = 1;
  ServerReflectionRequest original_request = 2;
  oneof message_response {
    FileDescriptorResponse file_descriptor_response = 4;
    ExtensionNumberResponse all_extension_numbers_response = 5;
    ListServiceResponse list_services_response = 6;
    ErrorResponse error_response = 7;
  }
}
message FileDescriptorResponse { repeated bytes file_descriptor_proto = 1; }
message ExtensionNumberResponse {
  string base_type_name = 1;
  repeated int32 extension_number = 2;
}
message ListServiceResponse { repeated ServiceResponse service = 1; }
message ServiceResponse { string name = 1; }
message ErrorResponse {
  int32 error_code = 1;
  string error_message = 2;
}
"#;
/// Files a server may describe for one call: enough for real APIs, bounded against loops.
const MAX_FILES: usize = 500;

/// The reflection service version a server answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Version {
    V1,
    V1Alpha,
}
impl Version {
    pub fn package(self) -> &'static str {
        match self {
            Self::V1 => "grpc.reflection.v1",
            Self::V1Alpha => "grpc.reflection.v1alpha",
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::V1 => "v1",
            Self::V1Alpha => "v1alpha",
        }
    }
}

struct Embedded;
impl FileResolver for Embedded {
    fn open_file(&self, name: &str) -> std::result::Result<File, protox::Error> {
        let package = match name {
            "grpc/reflection/v1/reflection.proto" => Version::V1.package(),
            "grpc/reflection/v1alpha/reflection.proto" => Version::V1Alpha.package(),
            _ => return Err(protox::Error::file_not_found(name)),
        };
        File::from_source(name, &REFLECTION.replace("PACKAGE", package))
    }
}
/// Both versions of `reflection.proto`, compiled once.
fn protocol() -> &'static DescriptorPool {
    static POOL: OnceLock<DescriptorPool> = OnceLock::new();
    POOL.get_or_init(|| {
        let mut compiler = protox::Compiler::with_file_resolver(Embedded);
        compiler
            .open_files([
                "grpc/reflection/v1/reflection.proto",
                "grpc/reflection/v1alpha/reflection.proto",
            ])
            .expect("the built-in reflection.proto compiles");
        compiler.descriptor_pool()
    })
}

/// A `google/protobuf/*` file a server left out, from the copies built into protox.
fn well_known(name: &str) -> Option<Vec<FileDescriptorProto>> {
    if !name.starts_with("google/protobuf/") {
        return None;
    }
    let mut resolver = ChainFileResolver::new();
    resolver.add(GoogleFileResolver::new());
    let mut compiler = protox::Compiler::with_file_resolver(resolver);
    compiler.include_imports(true);
    compiler.open_file(name).ok()?;
    Some(compiler.file_descriptor_set().file)
}

#[cfg(test)]
mod tests;
