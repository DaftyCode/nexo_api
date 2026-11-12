//! Imports: batches of documents written as they come. They are not recorded to undo them;
//! emptying the collection first needs its name repeated.
use super::{confirmed, read};
use crate::{
    Application,
    payloads::{ImportMode, MongoImportPayload},
    ports::{DatabaseConnection, ImportBatch, WriteTarget},
};
use nexo_domain::{Error, Result};
use serde_json::Value;

/// Documents in a batch at most; the interface sends larger imports in several.
pub(crate) const IMPORT_BATCH: usize = 5_000;

impl Application {
    pub(super) async fn import_batch(
        &self,
        payload: &Value,
        connection: DatabaseConnection,
    ) -> Result<Value> {
        let p: MongoImportPayload = read(payload)?;
        if p.documents.len() > IMPORT_BATCH {
            return Err(Error::Validation(format!(
                "Send at most {IMPORT_BATCH} documents in a batch"
            )));
        }
        let upsert_key = match p.mode.unwrap_or_default() {
            ImportMode::Insert => None,
            ImportMode::Upsert => {
                let key: Vec<String> = p
                    .key
                    .unwrap_or_default()
                    .into_iter()
                    .map(|field| field.trim().to_string())
                    .filter(|field| !field.is_empty())
                    .collect();
                if key.is_empty() {
                    return Err(Error::Validation(
                        "Choose the fields that find the document to replace".into(),
                    ));
                }
                Some(key)
            }
        };
        let clear = p.clear_confirm.is_some();
        if clear {
            confirmed(p.clear_confirm.as_deref(), &p.collection, "collection")?;
        }
        let target = WriteTarget {
            database: p.database,
            collection: p.collection,
            write_concern: p.write_concern.map(Value::Object),
        };
        let batch = ImportBatch {
            documents: p.documents.into_iter().map(Value::Object).collect(),
            upsert_key,
            clear,
            ordered: p.ordered.unwrap_or(false),
        };
        let result = self.database.import(connection, target, batch).await?;
        serde_json::to_value(result).map_err(|error| Error::Infrastructure(error.to_string()))
    }
}
