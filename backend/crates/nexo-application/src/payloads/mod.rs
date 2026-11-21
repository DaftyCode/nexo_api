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

#[macro_use]
mod declare;

mod auth;
mod common;
mod datasource;
mod datasource_admin;
mod datasource_compare;
mod datasource_network;
mod git;
mod http;
mod masking;
mod modules;
mod mongo_compare;
mod mongo_read;
mod mongo_schema;
mod mongo_write;
mod monitors;
mod native;
mod protocols;
mod ssh;
#[cfg(test)]
mod tests;
mod typescript;

pub use auth::*;
pub use common::*;
pub use datasource::*;
pub use datasource_admin::*;
pub use datasource_compare::*;
pub use datasource_network::*;
pub use git::*;
pub use http::*;
pub use masking::*;
pub use modules::*;
pub use mongo_compare::*;
pub use mongo_read::*;
pub use mongo_schema::*;
pub use mongo_write::*;
pub use monitors::*;
pub use native::*;
pub use protocols::*;
pub use ssh::*;
pub use typescript::typescript_contract;

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
    SshTest => SshTestPayload,
    SshTrust => SshTrustPayload,
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
    MongoImport => MongoImportPayload,
    MongoAggregate => MongoAggregatePayload,
    MongoAggregateWrite => MongoAggregateWritePayload,
    MongoSchema => MongoSchemaPayload,
    MongoCollectionValidator => MongoCollectionValidatorPayload,
    MongoWatch => MongoWatchPayload,
    MongoShell => MongoShellPayload,
    MongoSql => MongoSqlPayload,
    MongoCompare => MongoComparePayload,
    MongoSync => MongoSyncPayload,
    ModulesList => WorkspacePayload,
    ModulesInstall => ModulePayload,
    ModulesInstallFile => ModuleFilePayload,
    ModulesProgress => ModulePayload,
    ModulesRemove => ModulePayload,
    DbTest => DbTestPayload,
    DbConnect => DbConnectPayload,
    DbDisconnect => DbSessionPayload,
    DbTree => DbObjectPayload,
    DbDescribe => DbObjectPayload,
    DbDdl => DbObjectPayload,
    DbExecute => DbExecutePayload,
    DbFetch => DbCursorPayload,
    DbClose => DbCursorPayload,
    DbCancel => DbCancelPayload,
    DbTransaction => DbTransactionPayload,
    DbTransactions => DbTransactionsPayload,
    DbRowsWrite => DbRowsWritePayload,
    DbExplain => DbExplainPayload,
    DbImport => DbImportPayload,
    DbConvert => DbConvertPayload,
    DbCopy => DbCopyPayload,
    DbSearch => DbSearchPayload,
    DbDdlModel => DbDdlModelPayload,
    DbDdlPlan => DbDdlPlanPayload,
    DbSessions => DbAdminPayload,
    DbLocks => DbAdminPayload,
    DbSessionKill => DbSessionKillPayload,
    DbDashboards => DbSessionPayload,
    DbDashboardRead => DbDashboardReadPayload,
    DbSplit => DbSplitPayload,
    DbDialect => DbDriverPayload,
    MonitorStatus => MonitorStatusPayload,
    MonitorRun => MonitorRunPayload,
    ResponseCompare => ResponseComparePayload,
    MaskApply => MaskApplyPayload,
    SchemaInfer => SchemaInferPayload,
    NativeLocate => NativeLocatePayload,
    NativeBackup => NativeRunPayload,
    NativeRestore => NativeRunPayload,
    NativeScript => NativeRunPayload,
    NativeStatus => IdPayload,
    NativeCancel => IdPayload,
    DbCompareSchema => DbCompareSchemaPayload,
    DbCompareScript => DbCompareSchemaPayload,
    DbCompareData => DbCompareDataPayload,
    DbSyncData => DbCompareDataPayload,
    DbRouteTest => DbRouteTestPayload,
}

/// Checks the payload of a Git operation.
pub fn validate_git(operation: GitOperation, payload: Value) -> Result<Value> {
    check::<GitPayload>(operation, payload)
}
