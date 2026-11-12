//! Writes to a document database: documents, collections, databases and indexes.
use serde::Serialize;
use serde_json::Value;

/// Where a write goes, and the write concern of this operation when it is not the
/// connection's (`{w, j, wtimeout}`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WriteTarget {
    pub database: String,
    pub collection: String,
    pub write_concern: Option<Value>,
}

/// A write on the documents of a collection. Documents and filters are Extended JSON.
#[derive(Debug, Clone, PartialEq)]
pub enum DocumentWrite {
    Insert {
        documents: Vec<Value>,
    },
    /// `update` is an update document or an aggregation pipeline.
    Update {
        filter: Value,
        update: Value,
        many: bool,
        /// With `many`, how many documents the person was told would change: if the filter
        /// now matches another number, nothing is written.
        expected: Option<u64>,
    },
    Replace {
        filter: Value,
        replacement: Value,
    },
    Delete {
        filter: Value,
        many: bool,
        expected: Option<u64>,
    },
    /// Undoes recorded changes: each document goes back to `before`, if it is still as
    /// `after` left it.
    Restore {
        changes: Vec<DocumentChange>,
    },
}

/// A document before and after a write; `None` where it did not exist.
#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
pub struct DocumentChange {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<Value>,
}

/// What a write did.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub matched: u64,
    pub modified: u64,
    pub deleted: u64,
    /// `_id` of each inserted (or upserted) document, in Extended JSON.
    pub inserted: Vec<Value>,
    /// Each document the write changed, to undo it. Writes of many documents do not list
    /// them.
    #[serde(skip)]
    pub changes: Vec<DocumentChange>,
}

/// Changes to databases and collections.
#[derive(Debug, Clone, PartialEq)]
pub enum CollectionChange {
    /// `options`: capped (`size`, `max`), `timeseries`, `validator` and its level and action,
    /// `collation`, `expireAfterSeconds`.
    Create {
        database: String,
        collection: String,
        options: Option<Value>,
    },
    Rename {
        database: String,
        collection: String,
        to: String,
    },
    Drop {
        database: String,
        collection: String,
    },
    DropDatabase {
        database: String,
    },
    /// Replaces the validation rules of a collection (`collMod`); an empty validator removes
    /// them. Level `off`, `strict` or `moderate`; action `error` or `warn`.
    Validator {
        database: String,
        collection: String,
        validator: Value,
        level: &'static str,
        action: &'static str,
    },
}

/// An index with how much room it takes and how often queries use it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexDetail {
    pub name: String,
    /// The index as `listIndexes` gives it (keys and options), in canonical Extended JSON.
    pub spec: Value,
    /// Bytes on disk, added up over the shards.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<i64>,
    /// Operations that used it since `since` (`$indexStats`), added up over the servers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accesses: Option<i64>,
    /// When the server started counting, in ISO 8601.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
}

/// Changes to the indexes of a collection.
#[derive(Debug, Clone, PartialEq)]
pub enum IndexChange {
    /// `keys` and `options` are Extended JSON documents; options are those of `createIndexes`.
    Create {
        database: String,
        collection: String,
        keys: Value,
        options: Option<Value>,
    },
    /// Hides an index from the query planner, or shows it again, without dropping it.
    Hide {
        database: String,
        collection: String,
        name: String,
        hidden: bool,
    },
    Drop {
        database: String,
        collection: String,
        name: String,
    },
}

/// A batch of an import: documents in Extended JSON written as they come, not recorded to
/// undo them.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportBatch {
    pub documents: Vec<Value>,
    /// With fields, a document replaces the one with the same values of them, or is
    /// inserted; without, every document is inserted.
    pub upsert_key: Option<Vec<String>>,
    /// Deletes every document of the collection first; its indexes stay.
    pub clear: bool,
    /// Stops at the first document that fails; otherwise the others are written.
    pub ordered: bool,
}

/// What a batch of an import did.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub inserted: u64,
    pub upserted: u64,
    pub replaced: u64,
    /// Documents deleted first, when the collection was emptied.
    pub cleared: u64,
    pub failed: Vec<ImportFailure>,
}

/// A document of the batch that was not written, by its position in the batch.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ImportFailure {
    pub index: u64,
    pub message: String,
}
