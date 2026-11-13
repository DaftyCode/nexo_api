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
                    | Operation::ModulesInstall
                    | Operation::ModulesInstallFile
                    | Operation::ModulesProgress
                    | Operation::ModulesRemove
            );
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

#[test]
fn checks_the_other_operation_groups() {
    let sign_in = json!({"action": "complete", "session": "s1", "url": "https://cb/?code=1"});
    assert_eq!(
        validate(Operation::Oauth2Authorize, sign_in.clone()).unwrap(),
        sign_in
    );
    let error = validate(Operation::Oauth2Authorize, json!({"action": "restart"})).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("at action: unknown variant `restart`"),
        "{error}"
    );
    assert!(validate(Operation::Oauth2Tokens, json!({"action": "rename"})).is_err());
    let error = validate(Operation::OauthToken, json!({"fields": {}})).unwrap_err();
    assert!(error.to_string().contains("missing field `url`"), "{error}");
    let error = validate(Operation::MockStart, json!({"port": "8080"})).unwrap_err();
    assert!(
        error.to_string().contains("at port: invalid type"),
        "{error}"
    );
    let error = validate(Operation::RealtimeConnect, json!({"qos": 3000})).unwrap_err();
    assert!(error.to_string().contains("at qos"), "{error}");
    let grpc = json!({"url": "localhost:50051", "proto": "syntax", "service": "s", "method": "m",
                      "tls": false, "message": {"name": "Nexo"}, "metadata": []});
    assert_eq!(validate(Operation::Grpc, grpc.clone()).unwrap(), grpc);
    // Git: the files of an export and the branch or message of the others.
    let export = json!({"workspace": "w1", "files": [{"id": "c1", "value": {"item": []}}]});
    assert_eq!(
        validate_git(GitOperation::Export, export.clone()).unwrap(),
        export
    );
    let error = validate_git(GitOperation::Commit, json!({"mesage": "typo"})).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("Invalid commit payload at mesage"),
        "{error}"
    );
    let error = validate_git(GitOperation::Export, json!({"files": [{"id": "c1"}]})).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("at files[0]: missing field `value`"),
        "{error}"
    );
}

#[test]
fn mongo_payloads_name_their_fields() {
    let test = json!({"workspace": "w1", "connection": {
        "uri": "mongodb://ana@db.test", "password": "{{vault:mongo}}", "caPem": "-----BEGIN"
    }});
    assert_eq!(validate(Operation::MongoTest, test.clone()).unwrap(), test);
    let error = validate(
        Operation::MongoTest,
        json!({"connection": {"uri": "mongodb://x", "tlsCAFile": "/etc/ca.pem"}}),
    )
    .unwrap_err();
    assert!(
        error.to_string().contains("at connection.tlsCAFile"),
        "{error}"
    );
    let error = validate(Operation::MongoTest, json!({"connection": {}})).unwrap_err();
    assert!(error.to_string().contains("missing field `uri`"), "{error}");
    let find = json!({
        "connection": {"uri": "mongodb://h"}, "id": "q1", "database": "shop",
        "collection": "orders", "filter": {"_id": {"$oid": "65a1b2c3d4e5f6a7b8c9d0e1"}},
        "sort": {"at": -1}, "hint": "at_1", "skip": 20, "limit": 0, "pageSize": 50,
    });
    assert_eq!(validate(Operation::MongoFind, find.clone()).unwrap(), find);
    // A filter is a document, never a script.
    let error = validate(
        Operation::MongoFind,
        json!({"connection": {"uri": "mongodb://h"}, "id": "q", "database": "d",
            "collection": "c", "filter": "this.a > 1"}),
    )
    .unwrap_err();
    assert!(error.to_string().contains("filter"), "{error}");
    let error = validate(
        Operation::MongoCount,
        json!({"connection": {"uri": "mongodb://h"}, "id": "q", "database": "d",
            "collection": "c", "projection": {}}),
    )
    .unwrap_err();
    assert!(error.to_string().contains("projection"), "{error}");
    let more = json!({"cursor": "c1", "id": "q2", "pageSize": 20});
    assert_eq!(validate(Operation::MongoMore, more.clone()).unwrap(), more);
}

#[test]
fn index_explain_and_profiler_payloads_name_their_fields() {
    let connection = json!({"uri": "mongodb://h"});
    let explain = json!({
        "connection": connection, "id": "e1", "database": "shop", "collection": "orders",
        "verbosity": "executionStats", "filter": {"status": "A"}, "sort": {"at": -1},
    });
    assert_eq!(
        validate(Operation::MongoExplain, explain.clone()).unwrap(),
        explain
    );
    let error = validate(
        Operation::MongoExplain,
        json!({"connection": connection, "id": "e1", "database": "d", "collection": "c",
            "verbosity": "allPlansExecution"}),
    )
    .unwrap_err();
    assert!(error.to_string().contains("at verbosity"), "{error}");
    // A pipeline is a list of stages, never a script.
    let error = validate(
        Operation::MongoExplain,
        json!({"connection": connection, "id": "e1", "database": "d", "collection": "c",
            "pipeline": "db.c.aggregate([])"}),
    )
    .unwrap_err();
    assert!(error.to_string().contains("at pipeline"), "{error}");
    let error = validate(
        Operation::MongoIndexCreate,
        json!({"connection": connection, "connectionId": "c1", "database": "d",
            "collection": "c", "keys": "a_1"}),
    )
    .unwrap_err();
    assert!(error.to_string().contains("at keys"), "{error}");
    let error = validate(
        Operation::MongoIndexDrop,
        json!({"connection": connection, "connectionId": "c1", "database": "d",
            "collection": "c", "name": "a_1"}),
    )
    .unwrap_err();
    assert!(
        error.to_string().contains("missing field `confirm`"),
        "{error}"
    );
    let error = validate(
        Operation::MongoProfileSet,
        json!({"connection": connection, "connectionId": "c1", "database": "d", "level": -1}),
    )
    .unwrap_err();
    assert!(error.to_string().contains("at level"), "{error}");
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
