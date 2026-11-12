//! MongoDB payloads that compare two collections and make one like the other.
use super::*;

payload! {
    /// A collection of a connection, one side of a comparison.
    closed MongoCollectionRef {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            database "database": String => "string",
            collection "collection": String => "string",
        }
        optional {}
    }
}

payload! {
    /// `mongo.compare`: compares two collections (of one connection or two) by `key`
    /// (`_id` when absent), both read with `filter`, leaving out the `ignore` fields. Counts
    /// every kind of difference and describes the first `kept` (200 when absent, 1 000 at
    /// most). `id` cancels it with `mongo.cancel`.
    closed MongoComparePayload {
        required {
            id "id": String => "string",
            source "source": MongoCollectionRef => "MongoCollectionRef",
            target "target": MongoCollectionRef => "MongoCollectionRef",
        }
        optional {
            workspace "workspace": String => "string",
            filter "filter": Map<String, Value> => "object",
            key "key": String => "string",
            ignore "ignore": Vec<String> => "readonly string[]",
            kept "kept": u64 => "number",
        }
    }
}

payload! {
    /// `mongo.sync`: makes the target collection (`connection`, a saved connection that is not
    /// read-only, `database`, `collection`) like `source`: inserts what it lacks, replaces
    /// what differs and, with `remove`, deletes what only it has. `confirm` repeats the
    /// target collection's name. Not recorded to undo it.
    closed MongoSyncPayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            connection_id "connectionId": String => "string",
            id "id": String => "string",
            database "database": String => "string",
            collection "collection": String => "string",
            source "source": MongoCollectionRef => "MongoCollectionRef",
            confirm "confirm": String => "string",
        }
        optional {
            workspace "workspace": String => "string",
            filter "filter": Map<String, Value> => "object",
            key "key": String => "string",
            ignore "ignore": Vec<String> => "readonly string[]",
            remove "remove": bool => "boolean",
        }
    }
}
