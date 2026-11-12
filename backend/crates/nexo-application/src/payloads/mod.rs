//! Payloads of the execution operations, as types. They are checked when a request arrives,
//! before vault secrets are resolved or the engine runs anything: a misspelled field or a
//! wrong type is answered with a 400 that names it. The TypeScript interfaces in
//! `src/app/application/payloads.ts` come from the same declarations, and a test fails when
//! they are out of date.
//!
//! The top-level fields are closed: unknown ones are refused. Documents inside them
//! (collections, items, authorizations) keep the Postman format and stay open.
use crate::operations::{GitOperation, Operation};
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

mod auth;
mod common;
mod git;
mod http;
mod mongo_read;
mod mongo_write;
mod protocols;
#[cfg(test)]
mod tests;

pub use auth::*;
pub use common::*;
pub use git::*;
pub use http::*;
pub use mongo_read::*;
pub use mongo_write::*;
pub use protocols::*;

fn check<T: DeserializeOwned + Serialize>(
    operation: impl std::fmt::Display,
    payload: Value,
) -> Result<Value> {
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

/// Declares which payload each operation takes: `validate` matches every operation without a
/// wildcard, so a new operation without a payload does not compile, and the TypeScript map
/// of payloads comes from the same list.
macro_rules! operation_payloads {
    ($($operation:ident => $payload:ident),+ $(,)?) => {
        /// Checks an operation's payload against its type and returns it as the engine reads
        /// it.
        pub fn validate(operation: Operation, payload: Value) -> Result<Value> {
            match operation {
                $(Operation::$operation => check::<$payload>(operation, payload),)+
            }
        }
        /// `OperationPayloads`: the payload type of each operation, for TypeScript.
        fn typescript_map() -> String {
            let mut map = String::from(
                "/** The payload of each execution operation, checked by the backend. */\n\
                 export interface OperationPayloads {\n",
            );
            $({
                // Quoted only when the name is not an identifier, as Prettier writes it.
                let name = Operation::$operation.as_str();
                let key = if name.contains('.') {
                    format!("'{name}'")
                } else {
                    name.to_string()
                };
                map.push_str(&format!("  {key}: {};\n", stringify!($payload)));
            })+
            map.push_str("}\n");
            map
        }
        /// Each payload's interface, once, in the order of first use.
        fn typescript_interfaces() -> Vec<&'static str> {
            let mut interfaces: Vec<&'static str> = Vec::new();
            $(if !interfaces.contains(&$payload::TYPESCRIPT) {
                interfaces.push($payload::TYPESCRIPT);
            })+
            interfaces
        }
    };
}

operation_payloads! {
    Request => RequestPayload,
    Run => RunPayload,
    Cancel => IdPayload,
    RunPause => IdPayload,
    RunResume => IdPayload,
    Import => ImportPayload,
    ApiInspect => ApiInspectPayload,
    ApiDiff => ApiDiffPayload,
    Codegen => CodegenPayload,
    RealtimeConnect => RealtimeConnectPayload,
    RealtimeSend => RealtimeSendPayload,
    RealtimeClose => IdPayload,
    RealtimePoll => RealtimePollPayload,
    RealtimeList => WorkspacePayload,
    Grpc => GrpcPayload,
    MockStart => MockStartPayload,
    MockStop => IdPayload,
    MockList => WorkspacePayload,
    DatasetQuery => DatasetQueryPayload,
    DatasetImport => DatasetRowsPayload,
    DatasetSchema => IdPayload,
    DatasetParse => DatasetRowsPayload,
    DatasetDelete => IdPayload,
    McpRequest => McpRequestPayload,
    OauthToken => OauthTokenPayload,
    Oauth2Token => Oauth2TokenPayload,
    Oauth2Authorize => Oauth2AuthorizePayload,
    Oauth2Tokens => Oauth2TokensPayload,
    CookiesList => WorkspacePayload,
    CookiesClear => WorkspacePayload,
    CookiesSet => CookieSetPayload,
    CookiesDelete => CookieDeletePayload,
    Performance => PerformancePayload,
    PerformanceCancel => IdPayload,
    MongoTest => MongoConnectionPayload,
    MongoDatabases => MongoConnectionPayload,
    MongoCollections => MongoDatabasePayload,
    MongoStats => MongoCollectionPayload,
    MongoFind => MongoFindPayload,
    MongoMore => MongoMorePayload,
    MongoCount => MongoCountPayload,
    MongoCancel => IdPayload,
    MongoClose => MongoClosePayload,
    MongoInsert => MongoInsertPayload,
    MongoUpdate => MongoUpdatePayload,
    MongoReplace => MongoReplacePayload,
    MongoDelete => MongoDeletePayload,
    MongoUndo => MongoUndoPayload,
    MongoCollectionCreate => MongoCollectionCreatePayload,
    MongoCollectionRename => MongoCollectionRenamePayload,
    MongoCollectionDrop => MongoCollectionDropPayload,
    MongoDatabaseDrop => MongoDatabaseDropPayload,
    MongoIndexes => MongoCollectionPayload,
    MongoIndexCreate => MongoIndexCreatePayload,
    MongoIndexHide => MongoIndexHidePayload,
    MongoIndexDrop => MongoIndexDropPayload,
    MongoExplain => MongoExplainPayload,
    MongoProfile => MongoProfilePayload,
    MongoProfileSet => MongoProfileSetPayload,
    MongoProfileEntries => MongoProfileEntriesPayload,
}

/// Checks the payload of a Git operation.
pub fn validate_git(operation: GitOperation, payload: Value) -> Result<Value> {
    check::<GitPayload>(operation, payload)
}

/// The TypeScript contract written to `src/app/application/payloads.ts`.
pub fn typescript_contract() -> String {
    let mut parts = vec![
        "// Generated from backend/crates/nexo-application/src/payloads.rs.\n\
         // Regenerate with `NEXO_UPDATE_CONTRACTS=1 cargo test -p nexo-application`.\n\
         import type { ExecutionOperation } from './operations';\n"
            .to_string(),
        VariableRow::TYPESCRIPT.to_string(),
        ExecutionContext::TYPESCRIPT.to_string(),
        RunCursor::TYPESCRIPT.to_string(),
        FileAttachment::TYPESCRIPT.to_string(),
        CookieKey::TYPESCRIPT.to_string(),
        GitFile::TYPESCRIPT.to_string(),
        MongoConnection::TYPESCRIPT.to_string(),
    ];
    parts.extend(typescript_interfaces().into_iter().map(String::from));
    parts.push(GitPayload::TYPESCRIPT.to_string());
    parts.push(typescript_map());
    parts.push(
        "/** The payload of an operation. */\n\
         export type PayloadOf<O extends ExecutionOperation> = OperationPayloads[O];\n"
            .to_string(),
    );
    parts.join("\n")
}
