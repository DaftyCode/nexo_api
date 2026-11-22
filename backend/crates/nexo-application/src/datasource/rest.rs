//! The HTTP APIs of Elasticsearch and OpenSearch (DB-36) with the rules of every connection:
//! a read-only connection only reads; production asks before every change; deleting,
//! emptying or closing an index is confirmed by typing what it names, a wildcard included.
use super::{Application, redacted, sessions::session_name};
use crate::{payloads::DbRestRequestPayload, ports::DataSources};
use nexo_domain::{
    Error, Result,
    rest_api::{RequestKind, classify_request},
};
use serde_json::{Value, json};

fn refused(message: impl Into<String>) -> Error {
    Error::Validation(message.into())
}

impl Application {
    pub(super) async fn rest_request(
        &self,
        sources: &dyn DataSources,
        p: DbRestRequestPayload,
    ) -> Result<Value> {
        let session = self.sql_sessions.get(session_name(&p.session)?)?;
        let class = classify_request(&p.method, &p.path);
        let writes = class.kind == RequestKind::Write;
        let what = format!("{} {}", p.method.trim().to_ascii_uppercase(), p.path.trim());
        if session.read_only && writes {
            return Err(refused(format!(
                "The connection {} is read-only: Nexo sends only requests that read ({what} is not one)",
                session.name
            )));
        }
        if let Some(name) = &class.confirm {
            let typed = p.confirm_name.as_deref().map(str::trim).unwrap_or_default();
            if typed != name {
                return Err(refused(format!("Type {name} to confirm it")));
            }
        }
        if session.rules.confirm_writes && writes && !p.confirm.unwrap_or(false) {
            return Err(refused(format!(
                "The connection {} asks to confirm each change: confirm {what} first",
                session.name
            )));
        }
        let mut request = json!({"method": p.method, "path": p.path});
        if let Some(body) = p.body.filter(|body| !body.is_null()) {
            request["body"] = body;
        }
        redacted(
            sources.extension(&p.session, "rest.request", request).await,
            &session,
        )
    }
}
