//! Payloads of the engines that are not relational, on a session opened with `db.connect`:
//! the key-value stores (DB-35: Redis and Valkey) and the HTTP APIs (DB-36: Elasticsearch and
//! OpenSearch).
use super::*;
use std::collections::BTreeMap;

payload! {
    /// `db.kv.scan`: a page of keys, by `pattern` (a glob) and `type`, from `cursor`.
    closed DbKvScanPayload {
        required {
            session "session": String => "string",
        }
        optional {
            pattern "pattern": String => "string",
            kind "type": String => "string",
            cursor "cursor": String => "string",
            count "count": u32 => "number",
            workspace "workspace": String => "string",
        }
    }
}

payload! {
    /// `db.kv.get`: a key with its value, a collection by pages from `cursor`. The key is
    /// text, or `{"$t": "binary", "v": base64}`.
    closed DbKvGetPayload {
        required {
            session "session": String => "string",
            key "key": Value => "unknown",
        }
        optional {
            cursor "cursor": String => "string",
            count "count": u32 => "number",
            workspace "workspace": String => "string",
        }
    }
}

payload! {
    /// `db.kv.write`: `set` (a string's value, or a new key of `type`), `rename` (to `to`),
    /// `expire` (`ttlMs`, or none to keep it forever), `delete`, `put` or `remove` an
    /// element. Refused on a read-only connection; `delete` and every change on production
    /// need `confirm`.
    closed DbKvWritePayload {
        required {
            session "session": String => "string",
            key "key": Value => "unknown",
            action "action": String => "'set' | 'rename' | 'expire' | 'delete' | 'put' | 'remove'",
        }
        optional {
            kind "type": String => "string",
            value "value": Value => "unknown",
            field "field": Value => "unknown",
            score "score": f64 => "number",
            index "index": i64 => "number",
            fields "fields": Vec<Value> => "readonly unknown[]",
            to "to": Value => "unknown",
            ttl_ms "ttlMs": i64 => "number",
            confirm "confirm": bool => "boolean",
            workspace "workspace": String => "string",
        }
    }
}

payload! {
    /// `db.kv.command`: a command of the console, as its `line` (split as redis-cli does)
    /// or its `args`. A dangerous one (`FLUSHDB`, `CONFIG SET`…) needs `confirmName` with
    /// its name; a write on production, `confirm`; a read-only connection only reads.
    closed DbKvCommandPayload {
        required {
            session "session": String => "string",
        }
        optional {
            line "line": String => "string",
            args "args": Vec<Value> => "readonly unknown[]",
            confirm "confirm": bool => "boolean",
            confirm_name "confirmName": String => "string",
            workspace "workspace": String => "string",
        }
    }
}

payload! {
    /// `db.kv.subscribe`: follows `channels` and `patterns` of a saved connection in the
    /// realtime panel, which reads and closes it by the `id` it answers.
    closed DbKvSubscribePayload {
        required {
            workspace "workspace": String => "string",
            connection_id "connectionId": String => "string",
        }
        optional {
            channels "channels": Vec<String> => "readonly string[]",
            patterns "patterns": Vec<String> => "readonly string[]",
            variables "variables": BTreeMap<String, String> => "Readonly<Record<string, string>>",
        }
    }
}

payload! {
    /// `db.rest.request`: a request of the API of the session's engine, to a path of its node
    /// (`_cat/indices?v`, `shop/_search`). One that deletes, empties or closes an index needs
    /// `confirmName` with what it names; a write on production, `confirm`; a read-only
    /// connection only reads.
    closed DbRestRequestPayload {
        required {
            session "session": String => "string",
            method "method": String => "string",
            path "path": String => "string",
        }
        optional {
            body "body": Value => "unknown",
            confirm "confirm": bool => "boolean",
            confirm_name "confirmName": String => "string",
            workspace "workspace": String => "string",
        }
    }
}
