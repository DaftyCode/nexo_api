//! MongoDB payloads that write: documents, undo, collections, databases and indexes.
use super::*;

payload! {
    /// `mongo.insert`: inserts documents (Extended JSON). Writes name the saved connection
    /// (`connectionId`): a read-only one is refused.
    closed MongoInsertPayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            connection_id "connectionId": String => "string",
            database "database": String => "string",
            collection "collection": String => "string",
            documents "documents": Vec<Map<String, Value>> => "readonly object[]",
        }
        optional {
            workspace "workspace": String => "string",
            write_concern "writeConcern": Map<String, Value> => "object",
        }
    }
}

payload! {
    /// `mongo.update`: `update` is an update document or a pipeline. With `many`, `expected`
    /// is the count the person confirmed; a filter that matches another number writes nothing.
    closed MongoUpdatePayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            connection_id "connectionId": String => "string",
            database "database": String => "string",
            collection "collection": String => "string",
            filter "filter": Map<String, Value> => "object",
            update "update": Value => "object | readonly object[]",
        }
        optional {
            workspace "workspace": String => "string",
            many "many": bool => "boolean",
            expected "expected": u64 => "number",
            write_concern "writeConcern": Map<String, Value> => "object",
        }
    }
}

payload! {
    /// `mongo.replace`: replaces the document the filter matches.
    closed MongoReplacePayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            connection_id "connectionId": String => "string",
            database "database": String => "string",
            collection "collection": String => "string",
            filter "filter": Map<String, Value> => "object",
            replacement "replacement": Map<String, Value> => "object",
        }
        optional {
            workspace "workspace": String => "string",
            write_concern "writeConcern": Map<String, Value> => "object",
        }
    }
}

payload! {
    /// `mongo.delete`: with `many`, `expected` as in `mongo.update`; an empty filter (every
    /// document) also needs `confirm` with the collection's name.
    closed MongoDeletePayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            connection_id "connectionId": String => "string",
            database "database": String => "string",
            collection "collection": String => "string",
            filter "filter": Map<String, Value> => "object",
        }
        optional {
            workspace "workspace": String => "string",
            many "many": bool => "boolean",
            expected "expected": u64 => "number",
            confirm "confirm": String => "string",
            write_concern "writeConcern": Map<String, Value> => "object",
        }
    }
}

payload! {
    /// `mongo.undo`: undoes a recorded change (a `mongo-change` document).
    closed MongoUndoPayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            connection_id "connectionId": String => "string",
            change "change": String => "string",
        }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `mongo.collection.create`: also creates its database. Options: `capped`, `size`,
    /// `max`, `timeseries`, `validator`, `validationLevel`, `validationAction`, `collation`,
    /// `expireAfterSeconds`.
    closed MongoCollectionCreatePayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            connection_id "connectionId": String => "string",
            database "database": String => "string",
            collection "collection": String => "string",
        }
        optional {
            workspace "workspace": String => "string",
            options "options": Map<String, Value> => "object",
        }
    }
}

payload! {
    /// `mongo.collection.rename`: within its database.
    closed MongoCollectionRenamePayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            connection_id "connectionId": String => "string",
            database "database": String => "string",
            collection "collection": String => "string",
            to "to": String => "string",
        }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `mongo.collection.drop`: `confirm` repeats the collection's name.
    closed MongoCollectionDropPayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            connection_id "connectionId": String => "string",
            database "database": String => "string",
            collection "collection": String => "string",
            confirm "confirm": String => "string",
        }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `mongo.database.drop`: `confirm` repeats the database's name.
    closed MongoDatabaseDropPayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            connection_id "connectionId": String => "string",
            database "database": String => "string",
            confirm "confirm": String => "string",
        }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `mongo.index.create`: `keys` in Extended JSON (`{a: 1, b: -1}`, `{title: "text"}`,
    /// `{loc: "2dsphere"}`, `{"$**": 1}`). Options: `name`, `unique`, `sparse`, `hidden`,
    /// `expireAfterSeconds`, `partialFilterExpression`, `collation`, `weights`,
    /// `default_language`, `language_override`, `textIndexVersion`, `2dsphereIndexVersion`,
    /// `bits`, `min`, `max`, `wildcardProjection`.
    closed MongoIndexCreatePayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            connection_id "connectionId": String => "string",
            database "database": String => "string",
            collection "collection": String => "string",
            keys "keys": Map<String, Value> => "object",
        }
        optional {
            workspace "workspace": String => "string",
            options "options": Map<String, Value> => "object",
        }
    }
}

payload! {
    /// `mongo.index.hide`: hides an index from the query planner (`hidden`), or shows it.
    closed MongoIndexHidePayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            connection_id "connectionId": String => "string",
            database "database": String => "string",
            collection "collection": String => "string",
            name "name": String => "string",
            hidden "hidden": bool => "boolean",
        }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `mongo.index.drop`: `confirm` repeats the index's name.
    closed MongoIndexDropPayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            connection_id "connectionId": String => "string",
            database "database": String => "string",
            collection "collection": String => "string",
            name "name": String => "string",
            confirm "confirm": String => "string",
        }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `mongo.import`: a batch of documents written to a saved connection. `upsert` replaces
    /// the document with the same values of the `key` fields, or inserts it. `clearConfirm`,
    /// the collection's name, first deletes every document of the collection (its indexes
    /// stay). Without `ordered` the documents that fail are reported and the others written.
    closed MongoImportPayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            connection_id "connectionId": String => "string",
            database "database": String => "string",
            collection "collection": String => "string",
            documents "documents": Vec<Map<String, Value>> => "readonly object[]",
        }
        optional {
            workspace "workspace": String => "string",
            mode "mode": ImportMode => "'insert' | 'upsert'",
            key "key": Vec<String> => "readonly string[]",
            clear_confirm "clearConfirm": String => "string",
            ordered "ordered": bool => "boolean",
            write_concern "writeConcern": Map<String, Value> => "object",
        }
    }
}

payload! {
    /// `mongo.aggregate.write`: an aggregation whose last stage, `$out` or `$merge`, writes
    /// its results to a collection of a saved connection that is not read-only. `confirm`
    /// repeats the name of the collection written. `id` cancels it with `mongo.cancel`.
    closed MongoAggregateWritePayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            connection_id "connectionId": String => "string",
            id "id": String => "string",
            database "database": String => "string",
            collection "collection": String => "string",
            pipeline "pipeline": Vec<Map<String, Value>> => "readonly object[]",
            confirm "confirm": String => "string",
        }
        optional {
            workspace "workspace": String => "string",
            collation "collation": Map<String, Value> => "object",
            hint "hint": Value => "string | object",
            allow_disk_use "allowDiskUse": bool => "boolean",
            max_time_ms "maxTimeMS": u64 => "number",
        }
    }
}

/// How `mongo.import` writes each document.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportMode {
    #[default]
    Insert,
    Upsert,
}
