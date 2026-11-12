//! Changes to the server rather than to documents: collections, databases, indexes and the
//! profiler. They are not recorded to undo them; dropping needs the name repeated.
use super::{confirmed, read};
use crate::{
    Application,
    operations::Operation,
    payloads::{self, ValidationAction, ValidationLevel},
    ports::{CollectionChange, DatabaseConnection, IndexChange},
};
use nexo_domain::{Error, Result};
use serde_json::{Value, json};

impl Application {
    pub(super) async fn collection_change(
        &self,
        operation: Operation,
        payload: &Value,
        connection: DatabaseConnection,
    ) -> Result<Value> {
        // Indexes and the profiler: changes to the server, not to documents, so they are not
        // recorded to undo them.
        let index = match operation {
            Operation::MongoIndexCreate => {
                let p: payloads::MongoIndexCreatePayload = read(payload)?;
                if p.keys.is_empty() {
                    return Err(Error::Validation(
                        "Add at least one field to the index keys".into(),
                    ));
                }
                Some(IndexChange::Create {
                    database: p.database,
                    collection: p.collection,
                    keys: Value::Object(p.keys),
                    options: p.options.map(Value::Object),
                })
            }
            Operation::MongoIndexHide => {
                let p: payloads::MongoIndexHidePayload = read(payload)?;
                Some(IndexChange::Hide {
                    database: p.database,
                    collection: p.collection,
                    name: p.name,
                    hidden: p.hidden,
                })
            }
            Operation::MongoIndexDrop => {
                let p: payloads::MongoIndexDropPayload = read(payload)?;
                confirmed(Some(&p.confirm), &p.name, "index")?;
                Some(IndexChange::Drop {
                    database: p.database,
                    collection: p.collection,
                    name: p.name,
                })
            }
            Operation::MongoProfileSet => {
                let p: payloads::MongoProfileSetPayload = read(payload)?;
                if p.level > 2 {
                    return Err(Error::Validation(
                        "The profiler level is 0 (off), 1 (slow operations) or 2 (all)".into(),
                    ));
                }
                let slowms = p
                    .slowms
                    .map(|slowms| i64::try_from(slowms).unwrap_or(i64::MAX));
                let status = self
                    .database
                    .profile(connection, &p.database, Some((i64::from(p.level), slowms)))
                    .await?;
                return serde_json::to_value(status)
                    .map_err(|error| Error::Infrastructure(error.to_string()));
            }
            _ => None,
        };
        if let Some(index) = index {
            self.database.index(connection, index).await?;
            return Ok(json!({ "done": true }));
        }
        let change = match operation {
            Operation::MongoCollectionCreate => {
                let p: payloads::MongoCollectionCreatePayload = read(payload)?;
                CollectionChange::Create {
                    database: p.database,
                    collection: p.collection,
                    options: p.options.map(Value::Object),
                }
            }
            Operation::MongoCollectionRename => {
                let p: payloads::MongoCollectionRenamePayload = read(payload)?;
                CollectionChange::Rename {
                    database: p.database,
                    collection: p.collection,
                    to: p.to,
                }
            }
            Operation::MongoCollectionDrop => {
                let p: payloads::MongoCollectionDropPayload = read(payload)?;
                confirmed(Some(&p.confirm), &p.collection, "collection")?;
                CollectionChange::Drop {
                    database: p.database,
                    collection: p.collection,
                }
            }
            Operation::MongoDatabaseDrop => {
                let p: payloads::MongoDatabaseDropPayload = read(payload)?;
                confirmed(Some(&p.confirm), &p.database, "database")?;
                CollectionChange::DropDatabase {
                    database: p.database,
                }
            }
            Operation::MongoCollectionValidator => {
                let p: payloads::MongoCollectionValidatorPayload = read(payload)?;
                confirmed(Some(&p.confirm), &p.collection, "collection")?;
                CollectionChange::Validator {
                    database: p.database,
                    collection: p.collection,
                    validator: Value::Object(p.validator),
                    level: match p.validation_level.unwrap_or_default() {
                        ValidationLevel::Off => "off",
                        ValidationLevel::Strict => "strict",
                        ValidationLevel::Moderate => "moderate",
                    },
                    action: match p.validation_action.unwrap_or_default() {
                        ValidationAction::Error => "error",
                        ValidationAction::Warn => "warn",
                    },
                }
            }
            _ => return Err(Error::Validation("Unknown database operation".into())),
        };
        self.database.change(connection, change).await?;
        Ok(json!({ "done": true }))
    }
}
