//! Payloads of how a database connection reaches its server (DB-25).
use super::*;
use std::collections::BTreeMap;

payload! {
    /// `db.route.test`: the server of a connection reached through its SOCKS5 proxy or SSH
    /// tunnel, without opening a session; `port` is the engine's usual one, used when the
    /// connection has none.
    closed DbRouteTestPayload {
        required {}
        optional {
            workspace "workspace": String => "string",
            connection_id "connectionId": String => "string",
            connection "connection": Map<String, Value> => "Readonly<Record<string, unknown>>",
            variables "variables": BTreeMap<String, String> => "Readonly<Record<string, string>>",
            port "port": u16 => "number",
        }
    }
}
