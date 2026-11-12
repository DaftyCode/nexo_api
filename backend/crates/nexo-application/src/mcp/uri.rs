//! `nexo://workspaces/…` resource URIs.
use nexo_domain::WorkspaceId;

pub(super) const SCHEME: &str = "nexo://workspaces/";

/// Percent-encodes one segment of a `nexo://` URI.
pub(super) fn encode(segment: &str) -> String {
    segment
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}
pub(super) fn decode(segment: &str) -> Option<String> {
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = segment.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}
pub(super) fn uri(workspace: &WorkspaceId, path: &[&str]) -> String {
    let mut uri = format!("{SCHEME}{}", encode(workspace.as_str()));
    for segment in path {
        uri.push('/');
        uri.push_str(segment);
    }
    uri
}

/// A `nexo://` resource that `resources/read` understands.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Resource {
    Collection(WorkspaceId, String),
    Request(WorkspaceId, String, String),
    Environment(WorkspaceId, String),
    Globals(WorkspaceId),
    LastExecution(WorkspaceId),
    /// The databases and collections of an exposed MongoDB connection, by its name.
    MongoConnection(WorkspaceId, String),
    /// The schema of a collection of an exposed MongoDB connection.
    MongoCollection(WorkspaceId, String, String, String),
}
pub(super) fn parse_uri(uri: &str) -> Option<Resource> {
    let rest = uri.strip_prefix(SCHEME)?;
    let parts: Vec<String> = rest.split('/').map(decode).collect::<Option<_>>()?;
    let workspace = WorkspaceId::parse(parts.first()?.clone()).ok()?;
    let parts: Vec<&str> = parts[1..].iter().map(String::as_str).collect();
    Some(match parts.as_slice() {
        ["collections", id] => Resource::Collection(workspace, (*id).into()),
        ["collections", id, "requests", request] => {
            Resource::Request(workspace, (*id).into(), (*request).into())
        }
        ["environments", id] => Resource::Environment(workspace, (*id).into()),
        ["globals"] => Resource::Globals(workspace),
        ["history", "latest"] => Resource::LastExecution(workspace),
        ["mongo", connection] => Resource::MongoConnection(workspace, (*connection).into()),
        ["mongo", connection, database, collection] => Resource::MongoCollection(
            workspace,
            (*connection).into(),
            (*database).into(),
            (*collection).into(),
        ),
        _ => return None,
    })
}
