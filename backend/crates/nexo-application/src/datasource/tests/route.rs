//! How a connection reaches its server (DB-25): its route and the SSH profile it names reach
//! the modules filled in, the proxy's password from the vault, and «Test the tunnel».
use super::*;

fn ssh_profile(fake: &Fake) {
    fake.documents.lock().unwrap().push(Document {
        id: DocumentId::parse("p1").unwrap(),
        workspace_id: WorkspaceId::parse("local").unwrap(),
        kind: DocumentKind::SshProfile,
        name: "Bastion".into(),
        revision: 1,
        updated_at: 0,
        value: json!({"host": "bastion.test", "port": 22, "username": "ana", "auth": "password",
                      "secret": "ssh-password:p1"}),
    });
}

#[tokio::test]
async fn a_session_reaches_its_server_through_the_ssh_profile_or_the_proxy_of_its_route() {
    let (application, fake, sources) =
        with_sources(json!({"route": {"via": "ssh", "profile": "p1"}}));
    ssh_profile(&fake);
    connect(&application, "s1").await.unwrap();
    let (_, connection) = sources.connected.lock().unwrap()[0].clone();
    assert_eq!(
        connection.route.route,
        json!({"via": "ssh", "profile": "p1"})
    );
    let profile = &connection.route.profiles["p1"];
    assert_eq!(profile["host"], "bastion.test");
    assert_eq!(profile["password"], "secret-of-ssh-password:p1");
    assert!(!format!("{connection:?}").contains("secret-of"));

    let (application, _, sources) = with_sources(json!({"route": {
        "via": "socks5", "host": "proxy.test", "port": 1080, "username": "ana",
        "password": "{{vault:db-proxy:c1}}", "remoteDns": true}}));
    connect(&application, "s1").await.unwrap();
    let (_, connection) = sources.connected.lock().unwrap()[0].clone();
    assert_eq!(connection.route.route["password"], "secret-of-db-proxy:c1");
    assert_eq!(connection.route.profiles, Value::Null);
    assert!(!format!("{connection:?}").contains("secret-of"));
}

#[tokio::test]
async fn the_tunnel_is_tested_without_a_session_and_a_direct_connection_has_none() {
    let (application, _, sources) = with_sources(json!({"port": null, "route": {
        "via": "socks5", "host": "proxy.test", "password": "{{vault:db-proxy:c1}}"}}));
    let reached = application
        .execute(
            Operation::DbRouteTest,
            json!({"workspace": "local", "connectionId": "c1", "variables": {"host": "db.test"},
                   "port": 5432}),
        )
        .await
        .unwrap();
    // The usual port of the engine, as the form sends it; the proxy's password kept out.
    assert_eq!(reached["port"], 5432);
    assert_eq!(reached["via"], "socks5");
    assert!(!reached.to_string().contains("secret-of"));
    assert!(sources.connected.lock().unwrap().is_empty());
    assert_eq!(
        sources.reached.lock().unwrap()[0].host.as_deref(),
        Some("db.test")
    );

    let (application, _, _) = with_sources(json!({}));
    let direct = application
        .execute(
            Operation::DbRouteTest,
            json!({"workspace": "local", "connectionId": "c1", "variables": {"host": "db.test"}}),
        )
        .await;
    assert!(message(direct).contains("goes straight to its server"));
    // A connection being written is checked as if it were saved: never an HTTP proxy.
    let http = application
        .execute(
            Operation::DbRouteTest,
            json!({"workspace": "local", "connection": {"driver": "postgres", "host": "db",
                   "route": {"via": "http", "host": "proxy"}}}),
        )
        .await;
    assert!(message(http).contains("not an HTTP proxy"));
}
