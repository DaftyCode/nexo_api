//! Calling a method: metadata, the request, the connection and the streams.
use super::*;

pub(crate) fn status_error(status: Status) -> Error {
    invalid(format!(
        "{} {:?}: {}",
        status.code() as i32,
        status.code(),
        status.message()
    ))
}
pub(super) fn metadata(value: &Value) -> Result<MetadataMap> {
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

/// A client for the server address, through the addresses the egress policy approved, with
/// TLS, a custom CA and a client certificate when asked for.
pub(super) async fn connect(
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
pub(super) async fn invoke(
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
