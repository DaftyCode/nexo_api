//! Calls of scripts and the shell beyond documents: listing databases, collections and
//! indexes, creating an index and dropping a collection or a database, the last two only with
//! the name repeated, as in the interface.
use super::*;

impl Application {
    pub(super) async fn script_admin(
        &self,
        call: &ScriptCall,
        connection: Value,
        id: &str,
    ) -> Result<Value> {
        let mut payload = json!({"workspace": call.workspace, "connection": connection});
        let writer = |mut payload: Value| {
            payload["connectionId"] = json!(id);
            payload
        };
        let options = call.arguments.first().and_then(Value::as_object);
        let confirm = options
            .and_then(|options| options.get("confirm"))
            .and_then(Value::as_str)
            .map(String::from)
            .or_else(|| call.confirm.clone())
            .unwrap_or_default();
        if call.method == "listDatabases" {
            let answer = self.execute(Operation::MongoDatabases, payload).await?;
            return Ok(answer["databases"].clone());
        }
        payload["database"] = json!(call.database);
        match call.method.as_str() {
            "listCollections" => {
                let answer = self.execute(Operation::MongoCollections, payload).await?;
                Ok(answer["collections"].clone())
            }
            "dropDatabase" => {
                payload["confirm"] = json!(confirm);
                self.execute(Operation::MongoDatabaseDrop, writer(payload))
                    .await?;
                Ok(json!({"ok": 1, "dropped": call.database}))
            }
            method => {
                payload["collection"] = json!(call.collection);
                match method {
                    "getIndexes" => {
                        let answer = self.execute(Operation::MongoIndexes, payload).await?;
                        Ok(answer["indexes"].clone())
                    }
                    "createIndex" => {
                        payload["keys"] = call.arguments.first().cloned().unwrap_or(Value::Null);
                        if let Some(options) = call.arguments.get(1).filter(|o| o.is_object()) {
                            payload["options"] = options.clone();
                        }
                        self.execute(Operation::MongoIndexCreate, writer(payload))
                            .await?;
                        Ok(json!({"ok": 1}))
                    }
                    "drop" => {
                        payload["confirm"] = json!(confirm);
                        self.execute(Operation::MongoCollectionDrop, writer(payload))
                            .await?;
                        Ok(json!(true))
                    }
                    other => Err(Error::Validation(format!(
                        "nx.mongo collections have no method {other}"
                    ))),
                }
            }
        }
    }
}
