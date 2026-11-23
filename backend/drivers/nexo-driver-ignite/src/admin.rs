//! The queries running in the cluster (`SYSTEM.SQL_QUERIES`) and cancelling one with
//! `KILL QUERY`, as the administration of the SDK asks: Ignite's clients have no sessions of
//! their own to list, so each running query is one.
use crate::msgpack::uuid_bytes;
use nexo_driver_sdk::{
    DriverError, Result,
    admin::{AdminCatalog, AdminQuery, KillMode},
};

/// What marks the query that lists the others as the driver's own.
const OWN: &str = "nexo-own-sessions";

pub struct IgniteAdmin;

impl AdminCatalog for IgniteAdmin {
    fn sessions(&self) -> String {
        format!(
            "SELECT QUERY_ID, NULL, QUERY_DEFAULT_SCHEMA, QUERY_TYPE, INITIATOR_NODE, \
             QUERY_PHASE, TIMESTAMPDIFF(SECOND, QUERY_START_TIME, CURRENT_TIMESTAMP), NULL, SQL, \
             POSITION('{OWN}' IN SQL) > 0, TRUE FROM SYSTEM.SQL_QUERIES \
             WHERE PARENT_QUERY_ID IS NULL ORDER BY QUERY_START_TIME"
        )
    }
    fn locks(&self) -> String {
        "SELECT TRANSACTION_ID FROM SYSTEM.LOCKS WHERE 1 = 0".into()
    }
    fn privilege(&self) -> String {
        "SELECT CAST(NULL AS VARCHAR)".into()
    }
    fn own(&self) -> String {
        "SELECT CAST(NULL AS VARCHAR)".into()
    }
    /// `KILL QUERY` takes no bound value: the id goes in as the UUID it was checked to be.
    fn kill(&self, id: &str, mode: KillMode) -> Result<AdminQuery> {
        if mode == KillMode::Terminate {
            return Err(DriverError::unsupported(
                "Ignite cancels queries: its clients have no sessions to end",
            ));
        }
        let id = id.trim();
        if uuid_bytes(id).is_none() {
            return Err(DriverError::invalid(format!(
                "{id} is not the id of a query"
            )));
        }
        Ok(AdminQuery {
            sql: format!("KILL QUERY '{id}'"),
            params: Vec::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_query_is_cancelled_by_its_checked_id() {
        let id = "00112233-4455-6677-8899-aabbccddeeff";
        assert_eq!(
            IgniteAdmin.kill(id, KillMode::Cancel).unwrap().sql,
            format!("KILL QUERY '{id}'")
        );
        assert!(IgniteAdmin.kill("x' OR '1", KillMode::Cancel).is_err());
        assert!(IgniteAdmin.kill(id, KillMode::Terminate).is_err());
        assert!(IgniteAdmin.sessions().contains(OWN));
        assert!(IgniteAdmin.locks().contains("1 = 0"));
        assert!(IgniteAdmin.own().contains("NULL"));
        assert!(IgniteAdmin.privilege().contains("NULL"));
    }
}
