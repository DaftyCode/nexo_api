use super::*;

fn connection(uri: &str) -> DatabaseConnection {
    DatabaseConnection {
        uri: uri.into(),
        ..Default::default()
    }
}
fn directory() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("nexo-mongo-options-{}", uuid::Uuid::new_v4()))
}
async fn error(connection: DatabaseConnection) -> String {
    options(&connection, &directory())
        .await
        .unwrap_err()
        .to_string()
}

#[test]
fn reads_the_connection_of_connect() {
    let mut params = ConnectParams {
        connection: "c1".into(),
        password: Some("pw".into()),
        ..ConnectParams::default()
    };
    assert!(DatabaseConnection::from_params(&params).is_err());
    params.options.insert("uri".into(), "mongodb://db".into());
    params.options.insert("checkMembers".into(), "true".into());
    let connection = DatabaseConnection::from_params(&params).unwrap();
    assert_eq!(connection.name, "c1");
    assert_eq!(connection.uri, "mongodb://db");
    assert!(connection.check_members);
    assert!(!format!("{connection:?}").contains("pw"));
}

#[test]
fn refuses_other_schemes_undefined_variables_and_files() {
    assert!(check_uri("postgres://db").is_err());
    assert!(check_uri("mongodb://db.test:27017/app?replicaSet=rs0").is_ok());
    let undefined = check_uri("mongodb://{{host}}:27017")
        .unwrap_err()
        .to_string();
    assert!(undefined.contains("{{host}}"), "{undefined}");
    for option in [
        "tlsCAFile",
        "TLSCertificateKeyFile",
        "tlsCertificateKeyFilePassword",
    ] {
        let uri = format!("mongodb://db.test/?tls=true&{option}=/etc/x.pem");
        assert!(
            check_uri(&uri).unwrap_err().to_string().contains(option),
            "{option}"
        );
    }
}

#[tokio::test]
async fn adds_the_password_and_nexo_limits_without_overriding_the_uri() {
    let mut with_password = connection(
        "mongodb://ana@db1.test:27018,db2.test/app?authSource=admin&serverSelectionTimeoutMS=500&appName=Mine",
    );
    with_password.password = Some("p@ss:word".into());
    let (built, files) = options(&with_password, &directory()).await.unwrap();
    let credential = built.credential.unwrap();
    assert_eq!(credential.username.as_deref(), Some("ana"));
    assert_eq!(credential.password.as_deref(), Some("p@ss:word"));
    assert_eq!(credential.source.as_deref(), Some("admin"));
    assert_eq!(built.hosts.len(), 2);
    assert_eq!(
        built.server_selection_timeout,
        Some(Duration::from_millis(500))
    );
    assert_eq!(built.app_name.as_deref(), Some("Mine"));
    assert_eq!(built.connect_timeout, Some(limits::CONNECT));
    assert_eq!(built.max_pool_size, Some(limits::POOL));
    assert!(built.tls.is_none() && files.ca.is_none());

    let (built, _) = options(&connection("mongodb://db.test"), &directory())
        .await
        .unwrap();
    assert_eq!(built.app_name.as_deref(), Some("Nexo API"));
}

#[tokio::test]
async fn explains_credentials_that_cannot_work() {
    let mut no_user = connection("mongodb://db.test");
    no_user.password = Some("secret".into());
    assert!(error(no_user).await.contains("Add the user name"));
    let mut x509 = connection("mongodb://db.test/?authMechanism=MONGODB-X509&tls=true");
    x509.password = Some("secret".into());
    assert!(error(x509).await.contains("X.509"));
    let plain = connection("mongodb://ana:x@db.test/?authMechanism=PLAIN");
    let plain = error(plain).await;
    assert!(
        plain.contains("PLAIN authentication mechanism is not supported yet"),
        "{plain}"
    );
    let mut twice = connection("mongodb://ana:inline@db.test");
    twice.password = Some("secret".into());
    assert!(error(twice).await.contains("already has a password"));
}

#[tokio::test]
async fn certificates_turn_tls_on_unless_the_uri_turns_it_off() {
    let dir = directory();
    let cert = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
    let mut with_ca = connection("mongodb://db.test");
    with_ca.ca_pem = Some(cert.into());
    let (built, files) = options(&with_ca, &dir).await.unwrap();
    let Some(Tls::Enabled(tls)) = built.tls else {
        panic!("TLS is on")
    };
    assert_eq!(tls.ca_file_path, files.ca);
    assert!(files.ca.as_ref().unwrap().starts_with(&dir));

    let mut off = connection("mongodb://db.test/?tls=false");
    off.ca_pem = Some(cert.into());
    assert!(error(off).await.contains("TLS is off"));
    let hostnames = connection("mongodb://db.test/?tls=true&tlsAllowInvalidHostnames=true");
    assert!(
        error(hostnames)
            .await
            .contains("allow invalid certificates instead")
    );
    let (built, _) = options(
        &connection("mongodb://db.test/?tlsInsecure=true"),
        &directory(),
    )
    .await
    .unwrap();
    let Some(Tls::Enabled(tls)) = built.tls else {
        panic!("TLS is on")
    };
    assert_eq!(tls.allow_invalid_certificates, Some(true));
    drop(files);
    let _ = std::fs::remove_dir_all(dir);
}
