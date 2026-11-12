//! Finding vault references and encoding their values.
use crate::testing::*;
use crate::vault::{replace_vault, vault_references};

#[test]
fn vault_references_skip_script_fields() {
    let payload = json!({
        "request": {
            "url": "https://api.test/{{vault:url_secret}}",
            "prerequest": "// {{vault:script_secret}}",
            "event": [{"script": {"exec": ["{{vault:event_secret}}"]}}]
        },
        "context": {"ancestors": [{"auth": {"bearer": [{"value": "{{ vault:token }}"}]}}]}
    });
    let mut names = vault_references(&payload);
    names.sort();
    assert_eq!(names, vec!["token", "url_secret"]);
}

#[test]
fn vault_values_are_encoded_inside_uris() {
    let values = vec![("u".to_string(), "ana@corp:1/x".to_string())];
    assert_eq!(
        replace_vault("mongodb://{{vault:u}}@h/{{db}}", &values, true),
        "mongodb://ana%40corp%3A1%2Fx@h/{{db}}"
    );
    assert_eq!(
        replace_vault("{{vault:u}} {{x", &values, false),
        "ana@corp:1/x {{x"
    );
}
