//! The structure editor (DB-19): the model of a table and the types of its engine
//! (`db.ddl.model`), and the statements that change it (`db.ddl.plan`). Nothing runs here:
//! the statements go back to the person and run with `db.execute`, under its rules (never on
//! a read-only connection, confirmed on production, `DROP` with the name typed).
use super::{redacted, sessions::session_name};
use crate::{
    Application,
    payloads::{DbDdlModelPayload, DbDdlPlanPayload},
    ports::DataSources,
};
use nexo_domain::{Error, Result};
use serde_json::{Value, json};

impl Application {
    pub(super) async fn table_model(
        &self,
        sources: &dyn DataSources,
        payload: DbDdlModelPayload,
    ) -> Result<Value> {
        let session = self.sql_sessions.get(session_name(&payload.session)?)?;
        let request = json!({
            "connection": payload.session,
            "path": payload.path.unwrap_or_default(),
        });
        redacted(sources.ddl_model(&payload.session, request).await, &session)
    }

    pub(super) async fn table_plan(
        &self,
        sources: &dyn DataSources,
        payload: DbDdlPlanPayload,
    ) -> Result<Value> {
        let session = self.sql_sessions.get(session_name(&payload.session)?)?;
        if session.read_only {
            return Err(Error::Validation(format!(
                "The connection {} is read-only: its structure cannot change",
                session.name
            )));
        }
        let request = json!({
            "connection": payload.session,
            "original": payload.original,
            "target": payload.target,
            "cascade": payload.cascade.unwrap_or(false),
        });
        redacted(sources.ddl_plan(&payload.session, request).await, &session)
    }
}
