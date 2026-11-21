//! The client tools of connections set up with DB-25: they do not go through a route, and a
//! connection that keeps no password needs one typed for a session of it still open.
use super::native::{file, postgres, run, setup};
use crate::testing::*;

#[tokio::test]
async fn a_connection_that_asks_for_its_password_needs_a_session_with_it_typed() {
    let mut value = postgres();
    value.as_object_mut().unwrap().remove("password");
    value["askPassword"] = json!(true);
    let (application, tools) = setup(value);
    let options = json!({"options": {"path": file("shop.dump"), "format": "custom"}});
    let error = run(&application, Operation::NativeBackup, options)
        .await
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        "Open a session of the connection and type its password first"
    );
    assert!(tools.started.lock().unwrap().is_empty());
}

#[tokio::test]
async fn the_client_tools_do_not_go_through_a_route() {
    let mut value = postgres();
    value["route"] = json!({"via": "socks5", "host": "proxy.test"});
    let (application, tools) = setup(value);
    let options = json!({"options": {"path": file("shop.dump"), "format": "custom"}});
    let refused = run(&application, Operation::NativeBackup, options)
        .await
        .unwrap_err();
    assert!(
        refused
            .to_string()
            .contains("SOCKS5 proxy or an SSH tunnel"),
        "{refused}"
    );
    assert!(tools.started.lock().unwrap().is_empty());
}
