//! `nx.sql` (DB-32): a statement of a script runs on a session of its execution, opened once
//! with the script's variables and committing each statement; its parameters go bound; a
//! read-only connection refuses `execute`; the sessions close when the script ends.
use super::*;
use crate::ports::{ScriptDatabase, SqlCall};

fn call(method: &str, sql: &str) -> SqlCall {
    SqlCall {
        workspace: "local".into(),
        run: "r7".into(),
        connection: "Shop".into(),
        variables: json!({"host": "db.test", "port": 5432})
            .as_object()
            .cloned()
            .unwrap(),
        method: method.into(),
        sql: sql.into(),
        params: vec![json!(42), json!({"$t": "decimal", "v": "1.50"})],
        confirm: Value::Null,
    }
}

#[tokio::test]
async fn a_script_runs_on_a_session_of_its_own_with_bound_parameters_and_closes_it() {
    let (application, _, sources) = with_sources(json!({}));
    let rows = application
        .sql_call(call("query", "select n from t where id = $1"))
        .await
        .unwrap();
    assert_eq!(
        rows,
        json!({"columns": ["n"], "rows": [[1], [2]], "truncated": false, "affected": null})
    );
    application
        .sql_call(call("execute", "update t set n = 1 where id = $1"))
        .await
        .unwrap();
    // One session, opened once, with the script's variables filled in.
    let connected = sources.connected.lock().unwrap().clone();
    assert_eq!(connected.len(), 1);
    assert_eq!(connected[0].0, "script-r7-c1");
    assert_eq!(connected[0].1.host.as_deref(), Some("db.test"));
    let executed = sources.executed.lock().unwrap().clone();
    assert_eq!(executed.len(), 2);
    assert_eq!(executed[0].1.params.len(), 2);
    assert_eq!(executed[0].1.sql, "select n from t where id = $1");
    for method in ["begin", "commit"] {
        application.sql_call(call(method, "")).await.unwrap();
    }
    assert_eq!(
        sources.transactions.lock().unwrap().clone(),
        ["auto", "begin", "commit"]
    );
    application.sql_end("r7").await;
    assert_eq!(
        sources.disconnected.lock().unwrap().clone(),
        ["script-r7-c1"]
    );
    assert_eq!(
        sources
            .transactions
            .lock()
            .unwrap()
            .last()
            .map(String::as_str),
        Some("rollback")
    );
    // Another run, another session.
    application
        .sql_call(call("query", "select 1"))
        .await
        .unwrap();
    application.sql_end("other").await;
    assert_eq!(sources.connected.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn what_asks_for_a_confirmation_needs_it_and_a_read_only_connection_only_reads() {
    let (application, _, _) = with_sources(json!({}));
    let refused = application
        .sql_call(call("execute", "delete from t"))
        .await
        .unwrap_err();
    assert!(refused.to_string().contains("every row"), "{refused}");
    let mut confirmed = call("execute", "delete from t");
    confirmed.confirm = json!(true);
    application.sql_call(confirmed).await.unwrap();
    let mut named = call("execute", "drop table t");
    named.confirm = json!("t");
    application.sql_call(named).await.unwrap();

    let (reader, _, _) = with_sources(json!({"readOnly": true}));
    let error = reader
        .sql_call(call("execute", "select 1"))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("read-only"), "{error}");
    reader.sql_call(call("query", "select 1")).await.unwrap();
}

#[tokio::test]
async fn a_script_names_only_saved_sql_connections_and_cannot_type_a_password() {
    let (application, _, _) = with_sources(json!({}));
    let mut missing = call("query", "select 1");
    missing.connection = "Nowhere".into();
    assert_eq!(
        application.sql_call(missing).await.unwrap_err().to_string(),
        "No saved SQL connection is named Nowhere"
    );
    let mut by_id = call("query", "select 1");
    by_id.connection = "c1".into();
    application.sql_call(by_id).await.unwrap();
    let mut odd = call("rename", "");
    odd.run = "r8".into();
    assert!(
        application
            .sql_call(odd)
            .await
            .unwrap_err()
            .to_string()
            .contains("Unknown nx.sql call")
    );
    let mut bad = call("query", "select 1");
    bad.run = "../x".into();
    assert!(application.sql_call(bad).await.is_err());
    application.sql_end("../x").await;

    let (asking, _, _) = with_sources(json!({"askPassword": true, "password": null}));
    let error = asking
        .sql_call(call("query", "select 1"))
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("asks for its password each time"),
        "{error}"
    );
}
