//! The two use cases on top of the comparison: describing the differences (a read on both
//! sides) and making the target like the source (a write on the target, refused when it is
//! read-only, run only with its name repeated). The source documents a page brings are
//! written in batches as the comparison goes; deletions go at the end.
use super::*;
use crate::{
    database::{confirmed, read},
    payloads::{MongoCollectionRef, MongoComparePayload, MongoSyncPayload},
    ports::{DocumentWrite, ImportBatch, WriteTarget},
};
use nexo_domain::Error;
use serde_json::Map;
use std::time::Instant;

/// Documents written to the target at once.
const BATCH: usize = 1_000;

fn rules(
    filter: Option<Map<String, Value>>,
    key: Option<String>,
    ignore: Option<Vec<String>>,
) -> Rules {
    Rules {
        filter: filter
            .filter(|filter| !filter.is_empty())
            .map(Value::Object),
        key: key
            .map(|key| key.trim().to_string())
            .filter(|key| !key.is_empty())
            .unwrap_or_else(|| "_id".into()),
        ignore: ignore
            .unwrap_or_default()
            .into_iter()
            .map(|field| field.trim().to_string())
            .filter(|field| !field.is_empty())
            .collect(),
    }
}

/// What a sync writes, gathered while the comparison goes.
#[derive(Default)]
struct Writes {
    documents: Vec<Value>,
    removed: Vec<Value>,
    /// The key is not `_id`: a replacement keeps the target's `_id`.
    drop_id: bool,
}
impl Visitor for Writes {
    fn visit(&mut self, kind: Kind, key: &Value, source: Option<&Value>, _: Vec<FieldDifference>) {
        match (kind, source) {
            (Kind::OnlyTarget, _) => self.removed.push(key.clone()),
            (_, Some(document)) => {
                let mut document = document.clone();
                if self.drop_id
                    && let Some(fields) = document.as_object_mut()
                {
                    fields.remove("_id");
                }
                self.documents.push(document);
            }
            _ => {}
        }
    }
}

impl Application {
    async fn side(
        &self,
        side: MongoCollectionRef,
        values: &mut Vec<(String, String)>,
    ) -> Result<Side> {
        Ok(Side {
            connection: self.resolve_connection(side.connection, values).await?,
            database: side.database,
            collection: side.collection,
        })
    }

    pub(in crate::database) async fn compare(
        &self,
        payload: Value,
        values: &mut Vec<(String, String)>,
    ) -> Result<Value> {
        let p: MongoComparePayload = read(&payload)?;
        let started = Instant::now();
        let source = self.side(p.source, values).await?;
        let target = self.side(p.target, values).await?;
        let rules = rules(p.filter, p.key, p.ignore);
        let kept = p.kept.unwrap_or(KEPT).clamp(1, KEPT_MAX) as usize;
        let mut described = Described {
            kept,
            differences: Vec::new(),
            truncated: false,
        };
        let counts = self
            .compare_sides(&p.id, &source, &target, &rules, &mut described)
            .await?;
        Ok(json!({
            "counts": counts,
            "differences": described.differences,
            "truncated": described.truncated,
            "key": rules.key,
            "elapsedMs": started.elapsed().as_millis() as u64,
        }))
    }

    pub(in crate::database) async fn sync(
        &self,
        payload: &Value,
        connection: DatabaseConnection,
        values: &mut Vec<(String, String)>,
    ) -> Result<Value> {
        let p: MongoSyncPayload = read(payload)?;
        confirmed(Some(&p.confirm), &p.collection, "collection")?;
        let started = Instant::now();
        let source = self.side(p.source, values).await?;
        let target = Side {
            connection,
            database: p.database,
            collection: p.collection,
        };
        if source.connection.uri == target.connection.uri
            && source.database == target.database
            && source.collection == target.collection
        {
            return Err(Error::Validation(
                "Choose another collection to sync".into(),
            ));
        }
        let rules = rules(p.filter, p.key, p.ignore);
        let mut writes = Writes {
            drop_id: rules.key != "_id",
            ..Default::default()
        };
        let counts = self
            .compare_sides(&p.id, &source, &target, &rules, &mut writes)
            .await?;
        let where_ = WriteTarget {
            database: target.database.clone(),
            collection: target.collection.clone(),
            write_concern: None,
        };
        let (mut inserted, mut replaced, mut failed) = (0, 0, Vec::new());
        for batch in writes.documents.chunks(BATCH) {
            let result = self
                .database
                .import(
                    target.connection.clone(),
                    where_.clone(),
                    ImportBatch {
                        documents: batch.to_vec(),
                        upsert_key: Some(vec![rules.key.clone()]),
                        clear: false,
                        ordered: false,
                    },
                )
                .await?;
            inserted += result.inserted + result.upserted;
            replaced += result.replaced;
            failed.extend(
                result
                    .failed
                    .into_iter()
                    .take(20usize.saturating_sub(failed.len())),
            );
        }
        let mut deleted = 0;
        if p.remove.unwrap_or(false) {
            for keys in writes.removed.chunks(BATCH) {
                let write = DocumentWrite::Delete {
                    filter: json!({ rules.key.clone(): { "$in": keys } }),
                    many: true,
                    expected: Some(keys.len() as u64),
                };
                deleted += self
                    .database
                    .write(target.connection.clone(), where_.clone(), write)
                    .await?
                    .deleted;
            }
        }
        Ok(json!({
            "compared": counts,
            "inserted": inserted,
            "replaced": replaced,
            "deleted": deleted,
            "failed": failed,
            "elapsedMs": started.elapsed().as_millis() as u64,
        }))
    }
}
