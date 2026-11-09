//! gRPC server reflection (`grpc.reflection.v1` and the older `v1alpha` many servers still
//! use): the services a server offers and the descriptors of their files, so methods can be
//! called without pasting a `.proto`.
//!
//! The protocol is a bidirectional stream; each question is sent on a stream of its own and the
//! first answer read, which every server implementation accepts. `reflection.proto` is built in
//! and spoken with dynamic messages, so no generated code is needed.
use crate::grpc::{DynamicCodec, status_error};
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

/// A server that answers reflection, and the services it offers.
pub struct Reflection {
    pub version: Version,
    /// Without the reflection services themselves.
    pub services: Vec<String>,
}
impl Reflection {
    /// Lists the services with `v1`, or `v1alpha` when the server does not implement `v1`.
    /// The metadata (an authorization, for example) goes with every question.
    pub async fn open(
        client: &mut Grpc<Channel>,
        timeout: Duration,
        metadata: &MetadataMap,
    ) -> Result<Self> {
        let mut last = None;
        for version in [Version::V1, Version::V1Alpha] {
            match ask(client, timeout, metadata, version, "list_services", "*").await {
                Ok(answer) => {
                    let services = list_services(&answer)?
                        .into_iter()
                        .filter(|name| !name.starts_with("grpc.reflection."))
                        .collect();
                    return Ok(Self { version, services });
                }
                Err(status) if status.code() == Code::Unimplemented => last = Some(status),
                Err(status) => return Err(status_error(status)),
            }
        }
        Err(Error::Validation(format!(
            "The server does not offer reflection (grpc.reflection.v1 or v1alpha): {}",
            last.map(|status| status.message().to_string())
                .unwrap_or_default()
        )))
    }

    /// The descriptors of the files that define the symbols, with every file they import.
    pub async fn pool(
        &self,
        client: &mut Grpc<Channel>,
        timeout: Duration,
        metadata: &MetadataMap,
        symbols: &[String],
    ) -> Result<DescriptorPool> {
        let mut files: BTreeMap<String, FileDescriptorProto> = BTreeMap::new();
        for symbol in symbols {
            let answer = ask(
                client,
                timeout,
                metadata,
                self.version,
                "file_containing_symbol",
                symbol,
            )
            .await
            .map_err(status_error)?;
            add(&mut files, file_descriptors(&answer)?)?;
        }
        // Imports the server did not send with them, asked for by name.
        let mut asked: BTreeSet<String> = BTreeSet::new();
        loop {
            let missing: Vec<String> = files
                .values()
                .flat_map(|file| file.dependency.iter().cloned())
                .filter(|name| !files.contains_key(name) && !asked.contains(name))
                .collect();
            if missing.is_empty() {
                break;
            }
            for name in missing {
                asked.insert(name.clone());
                let answer = ask(
                    client,
                    timeout,
                    metadata,
                    self.version,
                    "file_by_filename",
                    &name,
                )
                .await;
                match answer {
                    Ok(answer) => add(&mut files, file_descriptors(&answer)?)?,
                    Err(status) => match well_known(&name) {
                        Some(found) => add(&mut files, found)?,
                        None => return Err(status_error(status)),
                    },
                }
            }
        }
        let mut pool = DescriptorPool::new();
        pool.add_file_descriptor_set(FileDescriptorSet {
            file: files.into_values().collect(),
        })
        .map_err(|error| {
            Error::Validation(format!("The server described its services badly: {error}"))
        })?;
        Ok(pool)
    }
}

fn add(
    files: &mut BTreeMap<String, FileDescriptorProto>,
    found: Vec<FileDescriptorProto>,
) -> Result<()> {
    for file in found {
        files.entry(file.name().to_string()).or_insert(file);
    }
    if files.len() > MAX_FILES {
        return Err(Error::Validation(
            "The server described more than 500 files".into(),
        ));
    }
    Ok(())
}

/// Sends one reflection question (`field` of `ServerReflectionRequest`) and reads the answer.
async fn ask(
    client: &mut Grpc<Channel>,
    timeout: Duration,
    metadata: &MetadataMap,
    version: Version,
    field: &str,
    value: &str,
) -> std::result::Result<DynamicMessage, Status> {
    let pool = protocol();
    let package = version.package();
    let request_type = pool
        .get_message_by_name(&format!("{package}.ServerReflectionRequest"))
        .expect("built in");
    let response_type = pool
        .get_message_by_name(&format!("{package}.ServerReflectionResponse"))
        .expect("built in");
    let mut question = DynamicMessage::new(request_type);
    question.set_field_by_name(field, Field::String(value.to_string()));
    let path = http::uri::PathAndQuery::try_from(format!(
        "/{package}.ServerReflection/ServerReflectionInfo"
    ))
    .map_err(|error| Status::internal(error.to_string()))?;
    client
        .ready()
        .await
        .map_err(|error| Status::unavailable(error.to_string()))?;
    let mut request = tonic::Request::new(futures_util::stream::iter([question]));
    *request.metadata_mut() = metadata.clone();
    request.set_timeout(timeout);
    let mut answers = client
        .streaming(request, path, DynamicCodec(response_type))
        .await?
        .into_inner();
    let answer = answers
        .message()
        .await?
        .ok_or_else(|| Status::internal("The server ended reflection without an answer"))?;
    if answer.has_field_by_name("error_response") {
        let error = message_field(&answer, "error_response");
        let code = error
            .get_field_by_name("error_code")
            .and_then(|value| value.as_i32())
            .unwrap_or(2);
        let text = error
            .get_field_by_name("error_message")
            .and_then(|value| value.as_str().map(String::from))
            .unwrap_or_default();
        return Err(Status::new(Code::from(code), text));
    }
    Ok(answer)
}

fn message_field(message: &DynamicMessage, name: &str) -> DynamicMessage {
    match message.get_field_by_name(name).as_deref() {
        Some(Field::Message(inner)) => inner.clone(),
        _ => DynamicMessage::new(
            message
                .descriptor()
                .get_field_by_name(name)
                .and_then(|field| field.kind().as_message().cloned())
                .expect("a message field"),
        ),
    }
}
fn list(message: &DynamicMessage, name: &str) -> Vec<Field> {
    match message.get_field_by_name(name).as_deref() {
        Some(Field::List(items)) => items.clone(),
        _ => Vec::new(),
    }
}

/// The service names of a `list_services_response`.
fn list_services(answer: &DynamicMessage) -> Result<Vec<String>> {
    if !answer.has_field_by_name("list_services_response") {
        return Err(Error::Validation(
            "The server did not list its services".into(),
        ));
    }
    let listed = message_field(answer, "list_services_response");
    Ok(list(&listed, "service")
        .iter()
        .filter_map(|service| match service {
            Field::Message(service) => service
                .get_field_by_name("name")
                .and_then(|name| name.as_str().map(String::from)),
            _ => None,
        })
        .collect())
}

/// The files of a `file_descriptor_response`.
fn file_descriptors(answer: &DynamicMessage) -> Result<Vec<FileDescriptorProto>> {
    let response = message_field(answer, "file_descriptor_response");
    list(&response, "file_descriptor_proto")
        .iter()
        .filter_map(|bytes| match bytes {
            Field::Bytes(bytes) => Some(FileDescriptorProto::decode(bytes.as_ref())),
            _ => None,
        })
        .collect::<std::result::Result<_, _>>()
        .map_err(|error| {
            Error::Validation(format!("The server sent an invalid descriptor: {error}"))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_versions_of_the_protocol_are_built_in() {
        for version in [Version::V1, Version::V1Alpha] {
            let service = protocol()
                .get_service_by_name(&format!("{}.ServerReflection", version.package()))
                .unwrap();
            let method = service.methods().next().unwrap();
            assert_eq!(method.name(), "ServerReflectionInfo");
            assert!(method.is_client_streaming() && method.is_server_streaming());
        }
        assert_eq!(Version::V1Alpha.name(), "v1alpha");
    }

    #[test]
    fn answers_are_read_from_dynamic_messages() {
        let response = protocol()
            .get_message_by_name("grpc.reflection.v1.ServerReflectionResponse")
            .unwrap();
        let mut answer = DynamicMessage::new(response.clone());
        assert!(list_services(&answer).is_err());
        let mut listed = message_field(&answer, "list_services_response");
        let service_type = listed
            .descriptor()
            .get_field_by_name("service")
            .unwrap()
            .kind()
            .as_message()
            .cloned()
            .unwrap();
        let mut service = DynamicMessage::new(service_type);
        service.set_field_by_name("name", Field::String("demo.Greeter".into()));
        listed.set_field_by_name("service", Field::List(vec![Field::Message(service)]));
        answer.set_field_by_name("list_services_response", Field::Message(listed));
        assert_eq!(list_services(&answer).unwrap(), ["demo.Greeter"]);

        let file = FileDescriptorProto {
            name: Some("demo.proto".into()),
            ..Default::default()
        };
        let mut described = DynamicMessage::new(response);
        let mut files = message_field(&described, "file_descriptor_response");
        files.set_field_by_name(
            "file_descriptor_proto",
            Field::List(vec![Field::Bytes(file.encode_to_vec().into())]),
        );
        described.set_field_by_name("file_descriptor_response", Field::Message(files));
        assert_eq!(file_descriptors(&described).unwrap(), [file]);
    }

    #[test]
    fn well_known_types_fill_imports_a_server_left_out() {
        let files = well_known("google/protobuf/timestamp.proto").unwrap();
        assert!(
            files
                .iter()
                .any(|file| file.name() == "google/protobuf/timestamp.proto")
        );
        assert!(well_known("other/thing.proto").is_none());
        let mut collected = BTreeMap::new();
        add(&mut collected, files).unwrap();
        let mut pool = DescriptorPool::new();
        pool.add_file_descriptor_set(FileDescriptorSet {
            file: collected.into_values().collect(),
        })
        .unwrap();
        assert!(
            pool.get_message_by_name("google.protobuf.Timestamp")
                .is_some()
        );
    }
}
