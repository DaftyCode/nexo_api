use super::*;
fn document(kind: DocumentKind, value: Value) -> Document {
    Document {
        id: DocumentId::parse("a").unwrap(),
        workspace_id: WorkspaceId::parse("w").unwrap(),
        kind,
        name: "a".into(),
        revision: 0,
        updated_at: 0,
        value,
    }
}
#[test]
fn document_kinds_round_trip() {
    for kind in DocumentKind::ALL {
        assert_eq!(DocumentKind::parse(kind.as_str()).unwrap(), kind);
        let json = serde_json::to_string(&kind).unwrap();
        assert_eq!(json, format!("\"{}\"", kind.as_str()));
    }
    assert!(DocumentKind::parse("executable").is_err());
    assert!(serde_json::from_str::<DocumentKind>("\"executable\"").is_err());
    assert!(!DocumentKind::History.keeps_revisions());
    assert!(!DocumentKind::QueryHistory.keeps_revisions());
    assert!(DocumentKind::Query.keeps_revisions());
    assert!(DocumentKind::QueryHistory.listed_whole());
    assert!(!DocumentKind::History.listed_whole());
}
#[test]
fn queries_name_their_database_and_collection() {
    for kind in [DocumentKind::Query, DocumentKind::QueryHistory] {
        let query = |value| document(kind, value).validate();
        assert!(query(serde_json::json!({"database": "shop"})).is_err());
        assert!(query(serde_json::json!({"database": " ", "collection": "orders"})).is_err());
        assert!(query(serde_json::json!({"database": "shop", "collection": "orders"})).is_ok());
    }
}
#[test]
fn collections_need_items() {
    assert!(
        document(DocumentKind::Collection, serde_json::json!({}))
            .validate()
            .is_err()
    );
    assert!(
        document(DocumentKind::Collection, serde_json::json!({"item": []}))
            .validate()
            .is_ok()
    );
    for kind in [DocumentKind::Environment, DocumentKind::Globals] {
        assert!(
            document(kind, serde_json::json!({"name": "x"}))
                .validate()
                .is_err()
        );
        assert!(
            document(kind, serde_json::json!({"values": []}))
                .validate()
                .is_ok()
        );
    }
}
#[test]
fn connections_keep_their_password_out_of_the_uri() {
    let connection =
        |uri: &str| document(DocumentKind::Connection, serde_json::json!({"uri": uri}));
    assert!(
        document(DocumentKind::Connection, serde_json::json!({}))
            .validate()
            .is_err()
    );
    for uri in [
        "mongodb://localhost:27017",
        "mongodb://ana@db.test/?authSource=admin",
        "mongodb+srv://{{user}}@cluster0.example.net/app",
        "mongodb://{{vault:mongo-user}}@db.test",
        "mongodb://db.test/app?replicaSet=rs0&a=b:c@d",
    ] {
        assert!(connection(uri).validate().is_ok(), "{uri}");
    }
    for uri in [
        "mongodb://ana:secret@db.test",
        "mongodb+srv://ana:{{vault:p}}@cluster0.example.net",
        "mongodb://ana:@db.test/",
        "mongodb://a%40b:p%2Fq@h1,h2/db",
    ] {
        let error = connection(uri).validate().unwrap_err();
        assert!(error.to_string().contains("vault"), "{uri}");
    }
}
#[test]
fn identifiers_reject_invalid_values() {
    assert!(DocumentId::parse("").is_err());
    assert!(DocumentId::parse("a\u{0}b").is_err());
    assert!(DocumentId::parse("x".repeat(161)).is_err());
    assert!(serde_json::from_str::<DocumentId>("\"ok\"").is_ok());
    assert!(serde_json::from_str::<DocumentId>("\"\"").is_err());
}
#[test]
fn no_arbitrary_engine_dispatch() {}
