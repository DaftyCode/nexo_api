//! The settings of a connection's sessions (DB-25).
use super::*;
use std::time::Duration;

#[test]
fn a_session_opens_on_its_default_schema_and_runs_its_startup_queries() {
    let value = json!({
        "defaultSchema": " sales, public ",
        "startupQueries": ["SET statement_timeout = 5000", " ", "SELECT 1"],
        "ignoreStartupErrors": true,
        "keepAliveSeconds": 60,
        "idleMinutes": 3,
        "connectTimeoutSeconds": 30,
    });
    let settings = SessionSettings::read(&value, Dialect::PostgreSql, true).unwrap();
    assert_eq!(
        settings.opening(Dialect::PostgreSql),
        [
            r#"SET search_path TO "sales", "public""#,
            "SET statement_timeout = 5000",
            "SELECT 1"
        ]
    );
    assert!(settings.ignore_startup_errors);
    assert_eq!(settings.keep_alive, Some(Duration::from_secs(60)));
    assert_eq!(settings.idle, Some(Duration::from_secs(180)));
    assert_eq!(settings.connect_timeout, Some(Duration::from_secs(30)));
    // Only PostgreSQL has a default schema of the session.
    assert_eq!(settings.opening(Dialect::MySql).len(), 2);
    assert_eq!(schema_statement(" , ", Dialect::PostgreSql), None);
    assert_eq!(keep_alive_query(Dialect::PlSql), "SELECT 1 FROM DUAL");
    assert_eq!(keep_alive_query(Dialect::TSql), "SELECT 1");
    assert_eq!(
        SessionSettings::read(&json!({}), Dialect::Ansi, false).unwrap(),
        SessionSettings::default()
    );
}

#[test]
fn startup_queries_and_times_are_checked_before_the_connection_is_saved() {
    let base = json!({"driver": "postgres", "host": "db"});
    let with = |field: &str, value: Value| {
        let mut changed = base.clone();
        changed[field] = value;
        connection(changed)
    };
    for (field, value, message) in [
        (
            "startupQueries",
            json!(["SET a = 1; SET b = 2"]),
            "one statement",
        ),
        ("startupQueries", json!([1]), "Each startup query"),
        (
            "startupQueries",
            json!("SET a = 1"),
            "up to 20 startup queries",
        ),
        ("keepAliveSeconds", json!(2), "Keep alive is from 5 to 600"),
        ("idleMinutes", json!(11), "from 1 to 10"),
        ("connectTimeoutSeconds", json!(0), "from 1 to 120"),
        ("defaultSchema", json!(7), "default schema"),
    ] {
        let error = with(field, value).unwrap_err().to_string();
        assert!(error.contains(message), "{field}: {error}");
    }
    with("startupQueries", json!(["UPDATE t SET a = 1"])).unwrap();
    // A read-only connection only reads or sets the session as it opens.
    let mut read_only = base.clone();
    read_only["readOnly"] = json!(true);
    read_only["startupQueries"] = json!(["SET search_path TO x", "SELECT now()"]);
    connection(read_only.clone()).unwrap();
    read_only["startupQueries"] = json!(["DELETE FROM log"]);
    let error = connection(read_only).unwrap_err().to_string();
    assert!(error.contains("only reads or sets the session"), "{error}");
}
