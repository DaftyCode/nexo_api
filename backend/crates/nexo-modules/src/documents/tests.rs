use super::*;

#[test]
fn errors_read_as_the_built_in_adapter_wrote_them() {
    let refused = error(DriverError::invalid("Nexo may not connect to db:27017: no"));
    assert_eq!(refused.to_string(), "Nexo may not connect to db:27017: no");
    assert!(matches!(refused, Error::Validation(_)));
    let closed = error(DriverError::closed("The connection closed after a while unused"));
    assert!(matches!(closed, Error::Validation(_)));
    assert!(matches!(
        error(DriverError::internal("disk")),
        Error::Infrastructure(_)
    ));
    // A script or an MCP tool does not download modules: it says how to get this one.
    let missing = error(DriverError::unsupported("The mongodb module is not installed"));
    assert!(
        missing
            .to_string()
            .contains("MongoDB is now a downloadable module"),
        "{missing}"
    );
    let other = error(DriverError::unsupported("No such method"));
    assert_eq!(other.to_string(), "No such method");
}
