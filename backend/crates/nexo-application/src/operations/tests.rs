use super::*;
#[test]
fn operations_round_trip_and_reject_unknown_names() {
    for operation in Operation::ALL {
        assert_eq!(Operation::parse(operation.as_str()).unwrap(), *operation);
    }
    for operation in GitOperation::ALL {
        assert_eq!(GitOperation::parse(operation.as_str()).unwrap(), *operation);
    }
    assert!(Operation::parse("shell.exec").is_err());
    assert!(Operation::parse("vault.get").is_err());
    // Only the operations Nexo runs itself: never arbitrary Git commands.
    for name in ["config", "gc", "remote", "submodule", "filter-branch"] {
        assert!(GitOperation::parse(name).is_err(), "{name}");
    }
}
#[test]
fn typescript_contract_is_current() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../src/app/application/operations.ts");
    let expected = typescript_contract();
    if std::env::var_os("NEXO_UPDATE_CONTRACTS").is_some() {
        std::fs::write(&path, &expected).unwrap();
    }
    let current = std::fs::read_to_string(&path)
        .unwrap_or_default()
        .replace("\r\n", "\n");
    assert_eq!(
        current, expected,
        "operations.ts is out of date; run NEXO_UPDATE_CONTRACTS=1 cargo test -p nexo-application"
    );
}
