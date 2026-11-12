//! Asking a server through reflection: its services and the files that describe them.
use super::*;

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

pub(super) fn add(
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
pub(super) async fn ask(
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

pub(super) fn message_field(message: &DynamicMessage, name: &str) -> DynamicMessage {
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
pub(super) fn list(message: &DynamicMessage, name: &str) -> Vec<Field> {
    match message.get_field_by_name(name).as_deref() {
        Some(Field::List(items)) => items.clone(),
        _ => Vec::new(),
    }
}

/// The service names of a `list_services_response`.
pub(super) fn list_services(answer: &DynamicMessage) -> Result<Vec<String>> {
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
pub(super) fn file_descriptors(answer: &DynamicMessage) -> Result<Vec<FileDescriptorProto>> {
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
