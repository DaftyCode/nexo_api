//! Payloads of the database modules' connections and statements (`db.*`).
use super::*;
use std::collections::BTreeMap;

payload! {
    /// `db.test`: a saved connection (`connectionId`) or one being written (`connection`),
    /// with the values of the environment variables it names.
    closed DbTestPayload {
        required {}
        optional {
            workspace "workspace": String => "string",
            connection_id "connectionId": String => "string",
            connection "connection": Map<String, Value> => "Readonly<Record<string, unknown>>",
            variables "variables": BTreeMap<String, String> => "Readonly<Record<string, string>>",
        }
    }
}

payload! {
    /// `db.connect`: opens a session named `session` on a saved connection.
    closed DbConnectPayload {
        required {
            connection_id "connectionId": String => "string",
            session "session": String => "string",
        }
        optional {
            workspace "workspace": String => "string",
            variables "variables": BTreeMap<String, String> => "Readonly<Record<string, string>>",
        }
    }
}

payload! {
    /// `db.disconnect`: a session.
    closed DbSessionPayload {
        required { session "session": String => "string" }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `db.tree`, `db.describe`, `db.ddl`: an object of a session's tree, by its path.
    closed DbObjectPayload {
        required { session "session": String => "string" }
        optional {
            path "path": Vec<String> => "readonly string[]",
            workspace "workspace": String => "string",
        }
    }
}

payload! {
    /// `db.execute`: one statement, its bound values, and the confirmations it needs
    /// (`confirm` for a write on production or every row; `confirmName` for a `DROP`).
    closed DbExecutePayload {
        required {
            session "session": String => "string",
            statement "statement": String => "string",
            sql "sql": String => "string",
        }
        optional {
            params "params": Vec<Value> => "readonly unknown[]",
            page_rows "pageRows": u32 => "number",
            max_rows "maxRows": u64 => "number",
            confirm "confirm": bool => "boolean",
            confirm_name "confirmName": String => "string",
            workspace "workspace": String => "string",
        }
    }
}

payload! {
    /// `db.fetch`, `db.close`: a cursor of a session.
    closed DbCursorPayload {
        required {
            session "session": String => "string",
            cursor "cursor": String => "string",
        }
        optional {
            page_rows "pageRows": u32 => "number",
            workspace "workspace": String => "string",
        }
    }
}

payload! {
    /// `db.cancel`: the statement of a session that is running.
    closed DbCancelPayload {
        required {
            session "session": String => "string",
            statement "statement": String => "string",
        }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `db.transaction`: `status`, `begin`, `commit`, `rollback`, `auto` or `manual`.
    closed DbTransactionPayload {
        required {
            session "session": String => "string",
            action "action": String => "string",
        }
        optional {
            isolation "isolation": String => "string",
            workspace "workspace": String => "string",
        }
    }
}

payload! {
    /// `db.split`: the statements of a script, and the one at `offset` (UTF-16 units).
    closed DbSplitPayload {
        required { script "script": String => "string" }
        optional {
            dialect "dialect": String => "string",
            offset "offset": u64 => "number",
            workspace "workspace": String => "string",
        }
    }
}

payload! {
    /// `db.dialect`: what the driver of a module says about itself.
    closed DbDriverPayload {
        required { driver "driver": String => "string" }
        optional { workspace "workspace": String => "string" }
    }
}
