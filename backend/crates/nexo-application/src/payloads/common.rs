//! Rows and identifiers shared by the payloads of several areas.
use super::*;

payload! {
    /// A variable as Postman environments and collections store it.
    open VariableRow {
        required { key "key": String => "string" }
        optional {
            value "value": Value => "unknown",
            enabled "enabled": bool => "boolean",
            disabled "disabled": bool => "boolean",
            kind "type": String => "string",
        }
    }
}

payload! {
    /// The collection and folders a single request belongs to, root first.
    closed ExecutionContext {
        required {}
        optional { ancestors "ancestors": Vec<Map<String, Value>> => "readonly object[]" }
    }
}

payload! {
    /// A file chosen for a request: the name its form-data field or binary body references
    /// (`src`) and its contents in base64. It is sent apart from the request, so scripts and
    /// saved documents only see the name.
    closed FileAttachment {
        required {
            src "src": String => "string",
            content "content": String => "string",
        }
        optional { content_type "contentType": String => "string" }
    }
}

payload! {
    /// What a run status has already delivered; it answers only what is new.
    closed RunCursor {
        required {}
        optional {
            results "results": u64 => "number",
            assertions "assertions": u64 => "number",
            logs "logs": u64 => "number",
        }
    }
}

payload! {
    /// `cancel`, `run.pause`, `run.resume`, `realtime.close`, `mock.stop`,
    /// `performance.cancel`: an identifier.
    closed IdPayload {
        required { id "id": String => "string" }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `realtime.list`, `mock.list`, `cookies.list`, `cookies.clear`: only the workspace.
    closed WorkspacePayload {
        required {}
        optional { workspace "workspace": String => "string" }
    }
}
