//! The operations on the database modules. They are not about a workspace: a module serves
//! every workspace on this computer.
use crate::{Application, operations::Operation};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use nexo_domain::{Error, Result};
use serde_json::{Map, Value};

/// The largest module file accepted from the person, as the releases publish it.
const MAX_FILE: usize = 32 * 1024 * 1024;

fn answer(value: impl serde::Serialize) -> Result<Value> {
    serde_json::to_value(value).map_err(|error| Error::Infrastructure(error.to_string()))
}

impl Application {
    pub(crate) async fn module(
        &self,
        operation: Operation,
        payload: &Map<String, Value>,
    ) -> Result<Value> {
        let modules = self
            .modules
            .as_ref()
            .ok_or_else(|| Error::Unavailable("Database modules are not available here".into()))?;
        let id = payload
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match operation {
            Operation::ModulesList => answer(modules.modules().await?),
            Operation::ModulesInstall => answer(modules.install(id).await?),
            Operation::ModulesProgress => answer(modules.progress(id).await?),
            Operation::ModulesRemove => {
                modules.remove(id).await?;
                Ok(Value::Object(Map::new()))
            }
            Operation::ModulesInstallFile => {
                let text = payload
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if text.len() > MAX_FILE / 3 * 4 + 4 {
                    return Err(Error::Validation(format!(
                        "A module file has at most {} MB",
                        MAX_FILE / 1024 / 1024
                    )));
                }
                let content = STANDARD
                    .decode(text.trim())
                    .map_err(|_| Error::Validation("The module file is not valid base64".into()))?;
                answer(modules.install_file(content).await?)
            }
            _ => Err(Error::Validation(format!(
                "{operation} is not an operation of the database modules"
            ))),
        }
    }
}
