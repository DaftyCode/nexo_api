//! gRPC calls described by `.proto` source or by server reflection, with dynamic messages.
use crate::egress::Policy;
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

/// Encodes and decodes messages described at run time.
#[derive(Clone)]
pub(crate) struct DynamicCodec(pub(crate) MessageDescriptor);
pub(crate) struct DynamicEncoder;
pub(crate) struct DynamicDecoder(MessageDescriptor);
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

fn to_json(message: &DynamicMessage) -> Value {
    let options = SerializeOptions::new()
        .use_proto_field_name(true)
        .skip_default_fields(false)
        .stringify_64_bit_integers(true);
    message
        .serialize_with_options(serde_json::value::Serializer, &options)
        .unwrap_or(Value::Null)
}
fn from_json(descriptor: &MessageDescriptor, value: &Value) -> Result<DynamicMessage> {
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
pub(crate) fn status_error(status: Status) -> Error {
    invalid(format!(
        "{} {:?}: {}",
        status.code() as i32,
        status.code(),
        status.message()
    ))
}
fn metadata(value: &Value) -> Result<MetadataMap> {
    let rows: Vec<(String, String)> = match value {
        Value::Array(rows) => rows
            .iter()
            .filter(|row| row["enabled"] != false)
            .filter_map(|row| {
                let key = row["key"].as_str().filter(|k| !k.is_empty())?;
                let value = match &row["value"] {
                    Value::String(text) => text.clone(),
                    Value::Null => String::new(),
                    other => other.to_string(),
                };
                Some((key.to_lowercase(), value))
            })
            .collect(),
        Value::Object(map) => map
            .iter()
            .map(|(k, v)| {
                (
                    k.to_lowercase(),
                    v.as_str()
                        .map(String::from)
                        .unwrap_or_else(|| v.to_string()),
                )
            })
            .collect(),
        _ => Vec::new(),
    };
    let mut map = MetadataMap::new();
    for (key, value) in rows {
        let error = || invalid(format!("Invalid metadata {key}"));
        if key.ends_with("-bin") {
            let name = MetadataKey::from_bytes(key.as_bytes()).map_err(|_| error())?;
            map.append_bin(name, BinaryMetadataValue::from_bytes(value.as_bytes()));
        } else {
            let name = MetadataKey::from_bytes(key.as_bytes()).map_err(|_| error())?;
            map.append(
                name,
                AsciiMetadataValue::try_from(value.as_str()).map_err(|_| error())?,
            );
        }
    }
    Ok(map)
}

/// Lists the services of a definition or a server, with their methods, or calls a method.
///
/// With `reflection`, the server describes its services (`grpc.reflection.v1` or `v1alpha`)
/// and no `.proto` is needed. Without `service`, the services and their methods are listed.
pub async fn request(payload: &Value, egress: &Policy, loopback_ports: &[u16]) -> Result<Value> {
    if payload["reflection"] == true {
        let (mut client, timeout) = connect(payload, egress, loopback_ports).await?;
        let headers = metadata(&payload["metadata"])?;
        let reflection =
            crate::grpc_reflection::Reflection::open(&mut client, timeout, &headers).await?;
        let version = reflection.version.name();
        let Some(name) = selected_service(payload) else {
            let pool = reflection
                .pool(&mut client, timeout, &headers, &reflection.services)
                .await?;
            let mut listed = discovery(&pool, &reflection.services);
            listed["reflection"] = json!(version);
            return Ok(listed);
        };
        if !reflection.services.iter().any(|service| service == name) {
            return Err(invalid(format!(
                "The server does not offer {name}. Available: {}",
                reflection.services.join(", ")
            )));
        }
        let pool = reflection
            .pool(&mut client, timeout, &headers, &[name.to_string()])
            .await?;
        let service = pool
            .get_service_by_name(name)
            .ok_or_else(|| invalid(format!("The server did not describe {name}")))?;
        let method = method_of(&service, payload)?;
        return invoke(client, method, payload, timeout).await;
    }
    let proto = payload["proto"].as_str().unwrap_or("");
    if proto.trim().is_empty() {
        return Err(invalid(
            "Provide a .proto service definition or use server reflection",
        ));
    }
    if proto.len() > MAX_PROTO {
        return Err(invalid("Proto definition is too large"));
    }
    let pool = compile(proto)?;
    let services: Vec<String> = pool
        .services()
        .filter(|service| service.parent_file().name() == SOURCE)
        .map(|service| service.full_name().to_string())
        .collect();
    let Some(service) = selected_service(payload).and_then(|name| pool.get_service_by_name(name))
    else {
        return Ok(discovery(&pool, &services));
    };
    // A wrong method name is answered before connecting.
    let method = method_of(&service, payload)?;
    let (client, timeout) = connect(payload, egress, loopback_ports).await?;
    invoke(client, method, payload, timeout).await
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

/// A client for the server address, through the addresses the egress policy approved, with
/// TLS, a custom CA and a client certificate when asked for.
async fn connect(
    payload: &Value,
    egress: &Policy,
    loopback_ports: &[u16],
) -> Result<(Grpc<Channel>, Duration)> {
    let address = payload["url"]
        .as_str()
        .filter(|u| !u.trim().is_empty())
        .ok_or_else(|| invalid("Enter the gRPC server address (host:port)"))?;
    let tls = payload["tls"] == true;
    let uri = format!(
        "{}://{}",
        if tls { "https" } else { "http" },
        address.trim()
    );
    let parsed =
        url::Url::parse(&uri).map_err(|_| invalid("Enter the gRPC server address (host:port)"))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| invalid("Enter the gRPC server address (host:port)"))?
        .to_string();
    let port = parsed.port_or_known_default().unwrap_or(443);
    let addresses: Vec<SocketAddr> = egress.resolve(&host, port, loopback_ports).await?;
    let timeout = Duration::from_millis(
        payload["timeout"]
            .as_u64()
            .filter(|t| *t > 0)
            .unwrap_or(30_000)
            .min(120_000),
    );
    let mut endpoint = Endpoint::from_shared(uri)
        .map_err(|error| invalid(error.to_string()))?
        .connect_timeout(Duration::from_secs(15))
        .timeout(timeout);
    if tls {
        let mut config = ClientTlsConfig::new()
            .with_native_roots()
            .domain_name(host.clone());
        if let Some(ca) = payload["caPem"].as_str().filter(|ca| !ca.trim().is_empty()) {
            config = config.ca_certificate(Certificate::from_pem(ca));
        }
        if let (Some(cert), Some(key)) = (payload["certPem"].as_str(), payload["keyPem"].as_str()) {
            config = config.identity(tonic::transport::Identity::from_pem(cert, key));
        }
        endpoint = endpoint
            .tls_config(config)
            .map_err(|error| invalid(error.to_string()))?;
    }
    // Connect only to the addresses the egress policy approved.
    let connector = tower::service_fn(move |_: http::Uri| {
        let addresses = addresses.clone();
        async move {
            tokio::net::TcpStream::connect(&addresses[..])
                .await
                .map(TokioIo::new)
        }
    });
    let channel = endpoint
        .connect_with_connector(connector)
        .await
        .map_err(|error| invalid(format!("14 Unavailable: {}", source_chain(&error))))?;
    Ok((Grpc::new(channel), timeout))
}

/// Calls a method of the service with the payload's message (or messages) and metadata.
async fn invoke(
    mut client: Grpc<Channel>,
    method: MethodDescriptor,
    payload: &Value,
    timeout: Duration,
) -> Result<Value> {
    client
        .ready()
        .await
        .map_err(|error| invalid(error.to_string()))?;
    let path = http::uri::PathAndQuery::try_from(format!(
        "/{}/{}",
        method.parent_service().full_name(),
        method.name()
    ))
    .map_err(|error| invalid(error.to_string()))?;
    let codec = DynamicCodec(method.output());
    let input = method.input();
    let messages: Vec<DynamicMessage> = if method.is_client_streaming() {
        match &payload["messages"] {
            Value::Array(items) => items
                .iter()
                .map(|item| from_json(&input, item))
                .collect::<Result<_>>()?,
            _ => vec![from_json(&input, &payload["message"])?],
        }
    } else {
        vec![from_json(&input, &payload["message"])?]
    };
    let headers = metadata(&payload["metadata"])?;
    let started = Instant::now();
    fn prepared<T>(message: T, headers: &MetadataMap, timeout: Duration) -> tonic::Request<T> {
        let mut request = tonic::Request::new(message);
        *request.metadata_mut() = headers.clone();
        request.set_timeout(timeout);
        request
    }
    let collect = |mut stream: tonic::Streaming<DynamicMessage>| async move {
        let mut output = Vec::new();
        while let Some(message) = stream.message().await.map_err(status_error)? {
            if output.len() < MAX_STREAM_MESSAGES {
                output.push(to_json(&message));
            }
        }
        Ok::<_, Error>(output)
    };
    let elapsed = |started: Instant| started.elapsed().as_millis() as u64;
    match (method.is_client_streaming(), method.is_server_streaming()) {
        (false, false) => {
            let message = messages
                .into_iter()
                .next()
                .unwrap_or_else(|| DynamicMessage::new(input.clone()));
            let response = client
                .unary(prepared(message, &headers, timeout), path, codec)
                .await
                .map_err(status_error)?;
            Ok(
                json!({"message": to_json(response.get_ref()), "time": elapsed(started), "status": 0}),
            )
        }
        (false, true) => {
            let message = messages
                .into_iter()
                .next()
                .unwrap_or_else(|| DynamicMessage::new(input.clone()));
            let response = client
                .server_streaming(prepared(message, &headers, timeout), path, codec)
                .await
                .map_err(status_error)?;
            let output = collect(response.into_inner()).await?;
            Ok(json!({"messages": output, "time": elapsed(started), "status": 0}))
        }
        (true, false) => {
            let stream = futures_util::stream::iter(messages);
            let response = client
                .client_streaming(prepared(stream, &headers, timeout), path, codec)
                .await
                .map_err(status_error)?;
            Ok(
                json!({"message": to_json(response.get_ref()), "time": elapsed(started), "status": 0}),
            )
        }
        (true, true) => {
            let stream = futures_util::stream::iter(messages);
            let response = client
                .streaming(prepared(stream, &headers, timeout), path, codec)
                .await
                .map_err(status_error)?;
            let output = collect(response.into_inner()).await?;
            Ok(json!({"messages": output, "time": elapsed(started), "status": 0}))
        }
    }
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
mod tests {
    use super::*;
    const PROTO: &str = r#"
syntax = "proto3";
package demo;
import "google/protobuf/timestamp.proto";
message Hello { string name = 1; int64 count = 2; google.protobuf.Timestamp at = 3; Kind kind = 4; }
enum Kind { A = 0; B = 1; }
service Greeter { rpc Say (Hello) returns (Hello); rpc Watch (Hello) returns (stream Hello); }
"#;
    #[tokio::test]
    async fn lists_services_and_validates_input() {
        let result = request(&json!({"proto": PROTO}), &Policy::AllowAll, &[])
            .await
            .unwrap();
        assert_eq!(result["services"], json!(["demo.Greeter"]));
        assert_eq!(
            result["methods"]["demo.Greeter"],
            json!([
                {"name": "Say", "input": "demo.Hello", "output": "demo.Hello",
                 "clientStreaming": false, "serverStreaming": false},
                {"name": "Watch", "input": "demo.Hello", "output": "demo.Hello",
                 "clientStreaming": false, "serverStreaming": true},
            ])
        );
        let missing = request(
            &json!({"proto": "syntax = \"proto3\"; import \"other.proto\";"}),
            &Policy::AllowAll,
            &[],
        )
        .await
        .unwrap_err();
        assert!(missing.to_string().contains("inline it"), "{missing}");
        let method = request(&json!({"proto": PROTO, "service": "demo.Greeter", "method": "Nope", "url": "127.0.0.1:1"}), &Policy::AllowAll, &[])
            .await
            .unwrap_err();
        assert!(method.to_string().contains("Say, Watch"), "{method}");
    }
    #[test]
    fn messages_round_trip_through_json() {
        let pool = compile(PROTO).unwrap();
        let descriptor = pool.get_message_by_name("demo.Hello").unwrap();
        let message = from_json(
            &descriptor,
            &json!({"name": "Nexo", "count": "9007199254740993", "kind": "B", "extra": 1}),
        )
        .unwrap();
        let value = to_json(&message);
        assert_eq!(value["name"], "Nexo");
        assert_eq!(value["count"], "9007199254740993");
        assert_eq!(value["kind"], "B");
        assert!(from_json(&descriptor, &json!({"name": 5})).is_err());
    }
}
