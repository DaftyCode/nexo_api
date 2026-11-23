//! Which operations need fields, and that no unknown field is taken.
use super::*;
use serde_json::json;

#[test]
fn every_operation_has_a_payload_type() {
    // An empty object is valid exactly when the operation has no required field.
    for operation in Operation::ALL {
        let result = validate(*operation, json!({}));
        // Every database operation names at least its connection.
        let required = operation.is_database()
            || matches!(
                operation,
                Operation::Cancel
                    | Operation::RunPause
                    | Operation::RunResume
                    | Operation::Import
                    | Operation::ApiInspect
                    | Operation::ApiDiff
                    | Operation::RealtimeSend
                    | Operation::RealtimeClose
                    | Operation::RealtimePoll
                    | Operation::MockStop
                    | Operation::DatasetQuery
                    | Operation::DatasetSchema
                    | Operation::DatasetDelete
                    | Operation::OauthToken
                    | Operation::CookiesSet
                    | Operation::CookiesDelete
                    | Operation::PerformanceCancel
                    | Operation::MongoShell
                    | Operation::MongoSql
                    | Operation::DbQueryParse
                    | Operation::DbTaskRun
                    | Operation::ModulesInstall
                    | Operation::ModulesInstallFile
                    | Operation::ModulesProgress
                    | Operation::ModulesRemove
                    | Operation::SshTest
                    | Operation::SshTrust
                    | Operation::MonitorStatus
                    | Operation::MonitorRun
                    | Operation::ResponseCompare
                    | Operation::MaskApply
                    | Operation::SchemaInfer
                    | Operation::NativeLocate
                    | Operation::NativeBackup
                    | Operation::NativeRestore
                    | Operation::NativeScript
                    | Operation::NativeStatus
                    | Operation::NativeCancel
            )
            // The assistant's operations name their provider, conversation or file; the
            // status of the local model, installing it and deleting it need nothing.
            || (operation.is_ai()
                && !matches!(
                    operation,
                    Operation::AiLocalStatus | Operation::AiLocalInstall | Operation::AiLocalRemove
                ))
            // A shared collection is named by its collection or its file; polling and the
            // status are of the whole workspace, and a new team key needs nothing.
            || (operation.is_shared()
                && !matches!(
                    operation,
                    Operation::SharedPoll | Operation::SharedStatus | Operation::SharedKeyNew
                ))
            // Every database operation names its session, script or driver; only a test (of
            // the connection or of its tunnel) may name nothing yet (and is refused
            // afterwards), and the list of open transactions is of the whole workspace.
            || (operation.is_datasource()
                && !matches!(
                    operation,
                    Operation::DbTest | Operation::DbRouteTest | Operation::DbTransactions
                ));
        assert_eq!(result.is_err(), required, "{operation}");
        assert!(
            validate(
                *operation,
                json!({"unknown": 1, "id": "x", "content": "", "sql": "", "url": ""})
            )
            .is_err(),
            "{operation}"
        );
    }
}
