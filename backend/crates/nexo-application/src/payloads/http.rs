//! Payloads of requests, collection runs, load tests, imports, API definitions and code
//! generation.
use super::*;

payload! {
    /// `request`: sends one request (or the collection item given), with its scripts.
    closed RequestPayload {
        required {}
        optional {
            workspace "workspace": String => "string",
            id "id": String => "string",
            request "request": Map<String, Value> => "object",
            item "item": Map<String, Value> => "object",
            collection "collection": Map<String, Value> => "object",
            variables "variables": Vec<VariableRow> => "readonly VariableRow[]",
            globals "globals": Vec<VariableRow> => "readonly VariableRow[]",
            context "context": ExecutionContext => "ExecutionContext",
            timeout "timeout": u64 => "number",
            strict_ssl "strictSSL": bool => "boolean",
            follow_redirects "followRedirects": bool => "boolean",
            trust_redirect_credentials "trustRedirectCredentials": bool => "boolean",
            transport "transport": Value => "unknown",
            files "files": Vec<FileAttachment> => "readonly FileAttachment[]",
        }
    }
}

payload! {
    /// `run`: starts a collection run, or with `action: "status"` reports one from `after`.
    closed RunPayload {
        required {}
        optional {
            workspace "workspace": String => "string",
            action "action": RunAction => "'status'",
            id "id": String => "string",
            after "after": RunCursor => "RunCursor",
            request "request": Map<String, Value> => "object",
            item "item": Map<String, Value> => "object",
            collection "collection": Map<String, Value> => "object",
            variables "variables": Vec<VariableRow> => "readonly VariableRow[]",
            globals "globals": Vec<VariableRow> => "readonly VariableRow[]",
            context "context": ExecutionContext => "ExecutionContext",
            data "data": Vec<Value> => "readonly unknown[]",
            iterations "iterations": u64 => "number",
            delay "delay": u64 => "number",
            global_timeout "globalTimeout": u64 => "number",
            timeout "timeout": u64 => "number",
            strict_ssl "strictSSL": bool => "boolean",
            follow_redirects "followRedirects": bool => "boolean",
            trust_redirect_credentials "trustRedirectCredentials": bool => "boolean",
            transport "transport": Value => "unknown",
            files "files": Vec<FileAttachment> => "readonly FileAttachment[]",
        }
    }
}

/// What a `run` call asks for besides starting a run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RunAction {
    Status,
}

payload! {
    /// `import`: a collection, environment, cURL command, HAR or OpenAPI document.
    closed ImportPayload {
        required { content "content": String => "string" }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `api.inspect`: the linter's findings and the outline of an OpenAPI or Swagger
    /// definition.
    closed ApiInspectPayload {
        required { source "source": String => "string" }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `api.diff`: what changed from the `base` definition to `source`, with the breaking
    /// changes marked.
    closed ApiDiffPayload {
        required {
            base "base": String => "string",
            source "source": String => "string",
        }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `codegen`: code that sends `request` in `language`.
    closed CodegenPayload {
        required {}
        optional {
            workspace "workspace": String => "string",
            request "request": Map<String, Value> => "object",
            language "language": String => "string",
            variant "variant": String => "string",
            follow_redirects "followRedirects": bool => "boolean",
        }
    }
}

payload! {
    /// `performance`: starts a load test of `request`, or with `action: "status"` reports one.
    closed PerformancePayload {
        required {}
        optional {
            workspace "workspace": String => "string",
            action "action": RunAction => "'status'",
            id "id": String => "string",
            request "request": Map<String, Value> => "object",
            users "users": u64 => "number",
            duration "duration": u64 => "number",
            profile "profile": String => "string",
            variables "variables": Vec<VariableRow> => "readonly VariableRow[]",
            globals "globals": Vec<VariableRow> => "readonly VariableRow[]",
            context "context": ExecutionContext => "ExecutionContext",
            strict_ssl "strictSSL": bool => "boolean",
            follow_redirects "followRedirects": bool => "boolean",
        }
    }
}
