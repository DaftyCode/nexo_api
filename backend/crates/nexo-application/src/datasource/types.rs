//! The type of a connection (DB-25): one of the three built in, or one of the person's own
//! (`connection-type` documents of the workspace), with the rules its sessions keep.
use crate::Application;
use nexo_domain::{
    DocumentKind, Error, Result, WorkspaceId,
    sql::{TypeOf, TypeRules},
};
use serde_json::Value;

impl Application {
    /// The rules of the type a connection names. A type of the person's own that no longer
    /// exists is refused rather than read as development: its confirmations would be lost.
    pub(crate) async fn type_rules(
        &self,
        workspace: &WorkspaceId,
        value: &Value,
    ) -> Result<TypeRules> {
        match TypeOf::read(value)? {
            TypeOf::Builtin(kind) => Ok(TypeRules::builtin(kind)),
            TypeOf::Own(id) => {
                let gone = || {
                    Error::Validation(
                        "The type of this connection no longer exists: choose another one".into(),
                    )
                };
                let document = self.workspaces.document(&id).await.map_err(|_| gone())?;
                if document.kind != DocumentKind::ConnectionType
                    || &document.workspace_id != workspace
                {
                    return Err(gone());
                }
                TypeRules::read(&document.value)
            }
        }
    }
}
