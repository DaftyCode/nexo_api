use super::{
    confirmed,
    connection::{check_same, matches_template},
    writes::expected,
};
use crate::payloads::MongoConnection;
use serde_json::json;

#[test]
fn a_connection_may_differ_only_by_its_variables() {
    assert!(matches_template("mongodb://h", "mongodb://h"));
    assert!(!matches_template("mongodb://h", "mongodb://other"));
    assert!(matches_template(
        "mongodb://{{host}}:27017/{{db}}?tls=true",
        "mongodb://db.test:27017/shop?tls=true"
    ));
    assert!(!matches_template(
        "mongodb://{{host}}:27017/?tls=true",
        "mongodb://db.test:27018/?tls=true"
    ));
    assert!(!matches_template("mongodb://{{host}}/x", "mongodb://a/y"));
    let stored = json!({"uri": "mongodb://ana@{{host}}", "password": "{{vault:p}}"});
    let sent = |uri: &str, password: Option<&str>| MongoConnection {
        uri: uri.into(),
        password: password.map(String::from),
        ..Default::default()
    };
    assert!(check_same(&stored, &sent("mongodb://ana@db.test", Some("{{vault:p}}"))).is_ok());
    assert!(check_same(&stored, &sent("mongodb://ana@db.test", Some("typed"))).is_err());
    assert!(
        check_same(
            &stored,
            &sent("mongodb://root@db.test", Some("{{vault:p}}"))
        )
        .is_err()
    );
    assert!(check_same(&stored, &sent("mongodb://ana@db.test", None)).is_err());
}

#[test]
fn many_documents_need_their_count_and_everything_needs_the_name() {
    assert!(expected(true, None).is_err());
    assert_eq!(expected(true, Some(3)).unwrap(), Some(3));
    assert_eq!(expected(false, Some(3)).unwrap(), None);
    assert!(confirmed(Some(" orders "), "orders", "collection").is_ok());
    assert_eq!(
        confirmed(Some("order"), "orders", "collection")
            .unwrap_err()
            .to_string(),
        "Type the name of the collection to confirm: orders"
    );
    assert!(confirmed(None, "shop", "database").is_err());
}
