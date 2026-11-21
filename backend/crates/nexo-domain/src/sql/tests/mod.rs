mod classify;
mod convert;
mod split;

use super::*;
use crate::{Document, DocumentId, DocumentKind, WorkspaceId};
use serde_json::{Value, json};

fn connection(value: Value) -> crate::Result<()> {
    Document {
        id: DocumentId::parse("c1").unwrap(),
        workspace_id: WorkspaceId::parse("local").unwrap(),
        kind: DocumentKind::Connection,
        name: "Orders".into(),
        revision: 0,
        updated_at: 0,
        value,
    }
    .validate()
}

#[test]
fn a_sql_connection_keeps_its_secrets_in_the_vault() {
    let base = json!({
        "driver": "postgres", "host": "db.example.com", "port": 5432, "database": "shop",
        "user": "ana", "password": "{{vault:db-password:c1}}", "type": "production",
        "tls": {"mode": "verify", "keyPem": "{{ vault:db-key:c1 }}"},
        "params": {"application_name": "Nexo"}, "timeoutSeconds": 30,
    });
    connection(base.clone()).unwrap();
    let with = |field: &str, value: Value| {
        let mut changed = base.clone();
        changed[field] = value;
        connection(changed)
    };
    for (field, value, message) in [
        (
            "password",
            json!("hunter2"),
            "Keep the password out of the connection",
        ),
        (
            "password",
            json!("{{vault:a}}{{vault:b}}"),
            "Keep the password",
        ),
        (
            "tls",
            json!({"keyPem": "-----BEGIN PRIVATE KEY-----"}),
            "Keep the client key",
        ),
        ("type", json!("staging"), "development, test or production"),
        ("port", json!(70000), "The port"),
        ("port", json!("http"), "The port"),
        ("driver", json!("Postgres"), "Unknown database driver"),
        ("params", json!({"x": 1}), "driver settings"),
        ("timeoutSeconds", json!(0), "time limit"),
        ("host", json!(7), "must be text"),
        (
            "route",
            json!({"via": "http", "host": "p"}),
            "not an HTTP proxy",
        ),
        ("route", json!({"via": "ssh"}), "SSH profile"),
        (
            "route",
            json!({"via": "socks5"}),
            "server of the SOCKS5 proxy",
        ),
        (
            "route",
            json!({"via": "socks5", "host": "p", "port": 0}),
            "port of the proxy",
        ),
        (
            "route",
            json!({"via": "socks5", "host": "p", "password": "pw"}),
            "password of the proxy",
        ),
        ("route", json!({"via": "carrier pigeon"}), "route"),
        ("route", json!("ssh"), "route"),
    ] {
        let error = with(field, value).unwrap_err().to_string();
        assert!(error.contains(message), "{field}: {error}");
    }
    // A variable of the environment may stand for the port; no server needs a database.
    with("port", json!("{{port}}")).unwrap();
    // It reaches its server directly, through an SSH profile or a SOCKS5 proxy.
    for route in [
        json!({"via": "direct"}),
        json!({"via": "ssh", "profile": "bastion"}),
        json!({"via": "socks5", "host": "proxy", "port": "{{proxyPort}}", "username": "ana",
               "password": "{{vault:db-proxy:c1}}", "remoteDns": true}),
    ] {
        with("route", route).unwrap();
    }
    let mut file = json!({"driver": "sqlite", "database": "C:/data/shop.db"});
    connection(file.clone()).unwrap();
    file["database"] = Value::Null;
    assert!(
        connection(file)
            .unwrap_err()
            .to_string()
            .contains("server or a database")
    );
    // Connections without a driver are MongoDB's, with their own rules.
    assert!(connection(json!({"uri": "mongodb://a:b@h"})).is_err());
    connection(json!({"driver": "mongodb", "uri": "mongodb://h"})).unwrap();
    assert_eq!(ConnectionType::of(&base), ConnectionType::Production);
    assert_eq!(ConnectionType::of(&json!({})), ConnectionType::Development);
}

#[test]
fn dialects_are_named_by_drivers_and_modules() {
    assert_eq!(Dialect::parse("postgresql"), Dialect::PostgreSql);
    assert_eq!(Dialect::parse("mssql"), Dialect::TSql);
    assert_eq!(Dialect::parse("MariaDB"), Dialect::MySql);
    assert_eq!(Dialect::parse("oracle"), Dialect::PlSql);
    assert_eq!(Dialect::parse("anything"), Dialect::Ansi);
}
