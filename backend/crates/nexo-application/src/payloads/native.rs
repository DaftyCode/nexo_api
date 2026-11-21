//! Payloads of the local client tools of the databases (`native.*`, desktop only).
use super::*;
use std::collections::BTreeMap;

payload! {
    /// `native.locate`: the tool a saved connection would use for `need`, in its local
    /// client folder (`folder` overrides it, to try one before saving it) or, without one,
    /// in the usual places; with its version.
    closed NativeLocatePayload {
        required { connection "connection": String => "string" }
        optional {
            workspace "workspace": String => "string",
            folder "folder": String => "string",
            need "need": String => "'backup' | 'server' | 'archive' | 'plain' | 'script'",
        }
    }
}

payload! {
    /// `native.backup`, `native.restore` and `native.script`: what to do with a saved
    /// connection, with the closed `options` of that action (the file chosen in a dialog
    /// among them). A restore needs `confirmName`, the database typed; on production also
    /// `confirm`, as a script does.
    closed NativeRunPayload {
        required {
            connection "connection": String => "string",
            options "options": Value => "Readonly<Record<string, unknown>>",
        }
        optional {
            workspace "workspace": String => "string",
            database "database": String => "string",
            variables "variables": BTreeMap<String, String> => "Readonly<Record<string, string>>",
            confirm "confirm": bool => "boolean",
            confirm_name "confirmName": String => "string",
            timeout_seconds "timeoutSeconds": u64 => "number",
        }
    }
}
