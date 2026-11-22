//! Writes: documents, collections, databases, indexes and imports. Documents and filters are
//! Extended JSON. The host has already checked that the connection may write.
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Where a write goes, and its write concern when it is not the connection's.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct WriteTarget {
    pub database: String,
    pub collection: String,
    pub write_concern: Option<Value>,
}

/// A write on the documents of a collection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DocumentWrite {
    Insert {
        documents: Vec<Value>,
    },
    Update {
        filter: Value,
        update: Value,
        many: bool,
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
    Restore {
        changes: Vec<DocumentChange>,
    },
}

/// A write and where it goes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteRequest {
    pub target: WriteTarget,
    pub write: DocumentWrite,
}

/// A document before and after a write; `None` where it did not exist.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct DocumentChange {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<Value>,
}

/// What a write did, with each document it changed so it can be undone.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WriteResult {
    pub matched: u64,
    pub modified: u64,
    pub deleted: u64,
    pub inserted: Vec<Value>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<DocumentChange>,
}

/// Changes to databases and collections.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CollectionChange {
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
    /// Level `off`, `strict` or `moderate`; action `error` or `warn`.
    Validator {
        database: String,
        collection: String,
        validator: Value,
        level: String,
        action: String,
    },
}

/// An index with how much room it takes and how often queries use it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IndexDetail {
    pub name: String,
    pub spec: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accesses: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
}

/// Changes to the indexes of a collection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum IndexChange {
    Create {
        database: String,
        collection: String,
        keys: Value,
        options: Option<Value>,
    },
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

/// A batch of an import, written as it comes.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct ImportBatch {
    pub documents: Vec<Value>,
    /// With fields, a document replaces the one with the same values of them, or is
    /// inserted; without, every document is inserted.
    pub upsert_key: Option<Vec<String>>,
    pub clear: bool,
    pub ordered: bool,
}

/// A batch of an import and where it goes.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportRequest {
    pub target: WriteTarget,
    pub batch: ImportBatch,
}

/// What a batch of an import did.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ImportResult {
    pub inserted: u64,
    pub upserted: u64,
    pub replaced: u64,
    pub cleared: u64,
    pub failed: Vec<ImportFailure>,
}

/// A document of the batch that was not written, by its position in the batch.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ImportFailure {
    pub index: u64,
    pub message: String,
}
