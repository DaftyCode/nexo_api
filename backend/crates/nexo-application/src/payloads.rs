//! Payloads of the execution operations, as types. They are checked when a request arrives,
//! before vault secrets are resolved or the engine runs anything: a misspelled field or a
//! wrong type is answered with a 400 that names it. The TypeScript interfaces in
//! `src/app/application/payloads.ts` come from the same declarations, and a test fails when
//! they are out of date.
//!
//! The top-level fields are closed: unknown ones are refused. Documents inside them
//! (collections, items, authorizations) keep the Postman format and stay open.
use crate::operations::Operation;
use nexo_domain::{Error, Result};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Map, Value};

/// Declares a payload struct and its TypeScript interface. `closed` refuses unknown fields;
/// `open` keeps them in `extra`, for rows that follow an outside format.
macro_rules! payload {
    (@struct [$($derive:tt)*] $(#[$meta:meta])* $name:ident
        { $($rfield:ident $rwire:literal : $rty:ty => $rts:literal,)* }
        { $($ofield:ident $owire:literal : $oty:ty => $ots:literal,)* }
        { $($extra:tt)* }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Default, Deserialize, Serialize)]
        $($derive)*
        pub struct $name {
            $(
                #[serde(rename = $rwire)]
                pub $rfield: $rty,
            )*
            $(
                #[serde(rename = $owire, default, skip_serializing_if = "Option::is_none")]
                pub $ofield: Option<$oty>,
            )*
            $($extra)*
        }
    };
    (
        $(#[$meta:meta])*
        closed $name:ident {
            required { $($rfield:ident $rwire:literal : $rty:ty => $rts:literal),* $(,)? }
            optional { $($ofield:ident $owire:literal : $oty:ty => $ots:literal),* $(,)? }
        }
    ) => {
        payload!(@struct [#[serde(deny_unknown_fields)]] $(#[$meta])* $name
            { $($rfield $rwire : $rty => $rts,)* }
            { $($ofield $owire : $oty => $ots,)* }
            {}
        );
        impl $name {
            pub const TYPESCRIPT: &'static str = concat!(
                "export interface ", stringify!($name), " {\n",
                $("  ", $rwire, ": ", $rts, ";\n",)*
                $("  ", $owire, "?: ", $ots, ";\n",)*
                "}\n"
            );
        }
    };
    (
        $(#[$meta:meta])*
        open $name:ident {
            required { $($rfield:ident $rwire:literal : $rty:ty => $rts:literal),* $(,)? }
            optional { $($ofield:ident $owire:literal : $oty:ty => $ots:literal),* $(,)? }
        }
    ) => {
        payload!(@struct [] $(#[$meta])* $name
            { $($rfield $rwire : $rty => $rts,)* }
            { $($ofield $owire : $oty => $ots,)* }
            {
                /// Fields of the outside format that Nexo passes along.
                #[serde(flatten)]
                pub extra: Map<String, Value>,
            }
        );
        impl $name {
            pub const TYPESCRIPT: &'static str = concat!(
                "export interface ", stringify!($name), " {\n",
                $("  ", $rwire, ": ", $rts, ";\n",)*
                $("  ", $owire, "?: ", $ots, ";\n",)*
                "  [field: string]: unknown;\n",
                "}\n"
            );
        }
    };
}

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
            global_timeout "globalTimeout": u64 => "number",
            timeout "timeout": u64 => "number",
            strict_ssl "strictSSL": bool => "boolean",
            follow_redirects "followRedirects": bool => "boolean",
            trust_redirect_credentials "trustRedirectCredentials": bool => "boolean",
            transport "transport": Value => "unknown",
        }
    }
}

/// What a `run` call asks for besides starting a run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RunAction {
    Status,
}

fn check<T: DeserializeOwned + Serialize>(operation: Operation, payload: Value) -> Result<Value> {
    // serde would also read a struct from an array of its fields.
    if !payload.is_object() {
        return Err(Error::Validation(format!(
            "Invalid {operation} payload: expected an object"
        )));
    }
    let typed: T = serde_path_to_error::deserialize(payload).map_err(|error| {
        let path = error.path().to_string();
        let reason = error.into_inner();
        Error::Validation(if path == "." {
            format!("Invalid {operation} payload: {reason}")
        } else {
            format!("Invalid {operation} payload at {path}: {reason}")
        })
    })?;
    serde_json::to_value(typed).map_err(|error| Error::Infrastructure(error.to_string()))
}

/// Checks an operation's payload against its type and returns it as the engine reads it.
/// Operations not typed yet pass unchanged; they are migrated group by group.
pub fn validate(operation: Operation, payload: Value) -> Result<Value> {
    match operation {
        Operation::Request => check::<RequestPayload>(operation, payload),
        Operation::Run => check::<RunPayload>(operation, payload),
        _ => Ok(payload),
    }
}

/// The TypeScript contract written to `src/app/application/payloads.ts`.
pub fn typescript_contract() -> String {
    [
        "// Generated from backend/crates/nexo-application/src/payloads.rs.\n\
         // Regenerate with `NEXO_UPDATE_CONTRACTS=1 cargo test -p nexo-application`.\n\
         import type { ExecutionOperation } from './operations';\n",
        VariableRow::TYPESCRIPT,
        ExecutionContext::TYPESCRIPT,
        RunCursor::TYPESCRIPT,
        RequestPayload::TYPESCRIPT,
        RunPayload::TYPESCRIPT,
        "/** Payloads the backend checks; the other operations are still being typed. */\n\
         export interface OperationPayloads {\n  request: RequestPayload;\n  run: RunPayload;\n}\n\
         /** The payload of an operation. */\n\
         export type PayloadOf<O extends ExecutionOperation> = O extends keyof OperationPayloads\n  \
         ? OperationPayloads[O]\n  : Record<string, unknown>;\n",
    ]
    .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_request_payload_keeps_what_the_engine_reads() {
        let payload = json!({
            "workspace": "w1",
            "id": "tab-1",
            "request": {"name": "Get", "request": {"url": "https://x", "nexoCustom": 1}},
            "variables": [{"key": "a", "value": 1, "enabled": true, "description": "kept"}],
            "globals": [],
            "context": {"ancestors": [{"name": "API", "auth": {"type": "bearer"}}]},
            "timeout": 5000,
            "strictSSL": false,
            "followRedirects": true,
        });
        let checked = validate(Operation::Request, payload.clone()).unwrap();
        assert_eq!(checked, payload, "nothing is added, renamed or dropped");
        // Absent fields stay absent: the engine treats a missing setting as its default.
        let minimal = validate(Operation::Request, json!({"request": {"url": "x"}})).unwrap();
        assert_eq!(minimal, json!({"request": {"url": "x"}}));
    }

    #[test]
    fn refuses_unknown_fields_and_wrong_types_naming_the_field() {
        let error = validate(Operation::Request, json!({"strictSsl": false})).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("Invalid request payload at strictSsl: unknown field `strictSsl`"),
            "{error}"
        );
        let error = validate(Operation::Request, json!({"strictSSL": "no"})).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("Invalid request payload at strictSSL: invalid type"),
            "{error}"
        );
        let error = validate(
            Operation::Request,
            json!({"variables": [{"key": "a"}, {"value": 1}]}),
        )
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("at variables[1]: missing field `key`"),
            "{error}"
        );
        let error = validate(Operation::Run, json!({"action": "pause"})).unwrap_err();
        assert!(
            error.to_string().contains("Invalid run payload at action"),
            "{error}"
        );
        let error = validate(Operation::Run, json!({"after": {"results": -1}})).unwrap_err();
        assert!(error.to_string().contains("at after.results"), "{error}");
        assert!(validate(Operation::Request, json!({"request": "https://x"})).is_err());
        assert!(validate(Operation::Run, json!([])).is_err());
    }

    #[test]
    fn run_payloads_start_and_poll_runs() {
        let start = json!({
            "collection": {"info": {"name": "C"}, "item": []},
            "variables": [], "globals": [], "data": [{"a": 1}, "x"],
            "iterations": 2, "globalTimeout": 60000, "strictSSL": true,
        });
        assert_eq!(validate(Operation::Run, start.clone()).unwrap(), start);
        let status = json!({"action": "status", "id": "r1", "after": {"results": 2, "logs": 1}});
        assert_eq!(validate(Operation::Run, status.clone()).unwrap(), status);
    }

    #[test]
    fn typescript_contract_is_current() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../src/app/application/payloads.ts");
        let expected = typescript_contract();
        if std::env::var_os("NEXO_UPDATE_CONTRACTS").is_some() {
            std::fs::write(&path, &expected).unwrap();
        }
        let current = std::fs::read_to_string(&path)
            .unwrap_or_default()
            .replace("\r\n", "\n");
        assert_eq!(
            current, expected,
            "payloads.ts is out of date; run NEXO_UPDATE_CONTRACTS=1 cargo test -p nexo-application"
        );
    }
}
