//! MongoDB payloads that read: connections, browsing, queries, explain and the profiler.
use super::*;

payload! {
    /// A MongoDB connection: the URI without a password (`mongodb://` or `mongodb+srv://`),
    /// the password (usually a `{{vault:…}}` reference) and the PEM of a CA to trust besides
    /// the system's and of a client certificate and key.
    closed MongoConnection {
        required { uri "uri": String => "string" }
        optional {
            password "password": String => "string",
            ca_pem "caPem": String => "string",
            cert_pem "certPem": String => "string",
            key_pem "keyPem": String => "string",
        }
    }
}

payload! {
    /// `mongo.test`: connects, pings and describes the deployment. `mongo.databases`: the
    /// databases the user may read.
    closed MongoConnectionPayload {
        required { connection "connection": MongoConnection => "MongoConnection" }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `mongo.collections`: the collections, views and time series of a database.
    closed MongoDatabasePayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            database "database": String => "string",
        }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `mongo.stats`: the size and indexes of a collection.
    closed MongoCollectionPayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            database "database": String => "string",
            collection "collection": String => "string",
        }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `mongo.find`: the first page of a query. Filter, projection, sort and collation are
    /// Extended JSON objects; `hint` is an index name or its keys. `id`, chosen by the client,
    /// cancels it with `mongo.cancel`.
    closed MongoFindPayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            id "id": String => "string",
            database "database": String => "string",
            collection "collection": String => "string",
        }
        optional {
            workspace "workspace": String => "string",
            filter "filter": Map<String, Value> => "object",
            projection "projection": Map<String, Value> => "object",
            sort "sort": Map<String, Value> => "object",
            collation "collation": Map<String, Value> => "object",
            hint "hint": Value => "string | object",
            skip "skip": u64 => "number",
            limit "limit": u64 => "number",
            page_size "pageSize": u64 => "number",
        }
    }
}

payload! {
    /// `mongo.more`: the next page of the `cursor` a `mongo.find` returned.
    closed MongoMorePayload {
        required {
            cursor "cursor": String => "string",
            id "id": String => "string",
        }
        optional {
            workspace "workspace": String => "string",
            page_size "pageSize": u64 => "number",
        }
    }
}

payload! {
    /// `mongo.count`: how many documents match a filter (`countDocuments`).
    closed MongoCountPayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            id "id": String => "string",
            database "database": String => "string",
            collection "collection": String => "string",
        }
        optional {
            workspace "workspace": String => "string",
            filter "filter": Map<String, Value> => "object",
            collation "collation": Map<String, Value> => "object",
            hint "hint": Value => "string | object",
            skip "skip": u64 => "number",
            limit "limit": u64 => "number",
        }
    }
}

payload! {
    /// `mongo.close`: closes a cursor the interface no longer reads.
    closed MongoClosePayload {
        required { cursor "cursor": String => "string" }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `mongo.explain`: how the server runs a `find` (filter, projection, sort, collation,
    /// hint, skip and limit as in `mongo.find`) or, with `pipeline`, an aggregation.
    /// `executionStats` runs the query to measure it; `queryPlanner` (the default) only plans
    /// it. `id` cancels it with `mongo.cancel`.
    closed MongoExplainPayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            id "id": String => "string",
            database "database": String => "string",
            collection "collection": String => "string",
        }
        optional {
            workspace "workspace": String => "string",
            verbosity "verbosity": ExplainVerbosity => "'queryPlanner' | 'executionStats'",
            filter "filter": Map<String, Value> => "object",
            projection "projection": Map<String, Value> => "object",
            sort "sort": Map<String, Value> => "object",
            collation "collation": Map<String, Value> => "object",
            hint "hint": Value => "string | object",
            skip "skip": u64 => "number",
            limit "limit": u64 => "number",
            pipeline "pipeline": Vec<Map<String, Value>> => "readonly object[]",
        }
    }
}

payload! {
    /// `mongo.aggregate`: the first page of an aggregation that only reads; `mongo.more`
    /// reads the next ones. Each stage, `collation` and `hint` are Extended JSON. A pipeline
    /// with `$out` or `$merge` runs only with `mongo.aggregate.write`. `maxTimeMS` is at most
    /// the operation limit. `id` cancels it with `mongo.cancel`.
    closed MongoAggregatePayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            id "id": String => "string",
            database "database": String => "string",
            collection "collection": String => "string",
            pipeline "pipeline": Vec<Map<String, Value>> => "readonly object[]",
        }
        optional {
            workspace "workspace": String => "string",
            collation "collation": Map<String, Value> => "object",
            hint "hint": Value => "string | object",
            allow_disk_use "allowDiskUse": bool => "boolean",
            max_time_ms "maxTimeMS": u64 => "number",
            page_size "pageSize": u64 => "number",
        }
    }
}

payload! {
    /// `mongo.profile`: the profiler level of a database and its `slowms`.
    closed MongoProfilePayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            database "database": String => "string",
        }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `mongo.profile.set`: changes the profiler of a database on the server: `level` 0 (off),
    /// 1 (operations slower than `slowms`) or 2 (every operation).
    closed MongoProfileSetPayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            connection_id "connectionId": String => "string",
            database "database": String => "string",
            level "level": u8 => "0 | 1 | 2",
        }
        optional {
            workspace "workspace": String => "string",
            slowms "slowms": u64 => "number",
        }
    }
}

payload! {
    /// `mongo.profile.entries`: the slowest operations in `system.profile`, of the whole
    /// database or of one `collection`.
    closed MongoProfileEntriesPayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            database "database": String => "string",
        }
        optional {
            workspace "workspace": String => "string",
            collection "collection": String => "string",
            limit "limit": u64 => "number",
        }
    }
}

/// How much an explain tells: the plan only, or the plan run and measured.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExplainVerbosity {
    #[default]
    QueryPlanner,
    ExecutionStats,
}
