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
    /// `db.connect`: opens a session named `session` on a saved connection; `database`
    /// opens it on another database of the same server.
    closed DbConnectPayload {
        required {
            connection_id "connectionId": String => "string",
            session "session": String => "string",
        }
        optional {
            database "database": String => "string",
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
    /// `db.rows.write`: rows changed in the data grid, written as one by the session's
    /// driver. `confirm` answers production and many deleted rows.
    closed DbRowsWritePayload {
        required {
            session "session": String => "string",
            table "table": String => "string",
            changes "changes": Vec<Value> => "readonly unknown[]",
        }
        optional {
            schema "schema": String => "string",
            optimistic "optimistic": bool => "boolean",
            confirm "confirm": bool => "boolean",
            workspace "workspace": String => "string",
        }
    }
}

payload! {
    /// `db.explain`: the plan of a statement of a session, `estimated` (the default) or
    /// `actual`. `confirm` answers the actual plan of a change, which runs and is rolled back.
    closed DbExplainPayload {
        required {
            session "session": String => "string",
            statement "statement": String => "string",
            sql "sql": String => "string",
        }
        optional {
            params "params": Vec<Value> => "readonly unknown[]",
            mode "mode": String => "'estimated' | 'actual'",
            confirm "confirm": bool => "boolean",
            workspace "workspace": String => "string",
        }
    }
}

payload! {
    /// `db.import`: a batch of rows written into a table of a session (DB-17).
    closed DbImportPayload {
        required {
            session "session": String => "string",
            table "table": String => "string",
            columns "columns": Vec<String> => "readonly string[]",
            rows "rows": Vec<Value> => "readonly (readonly unknown[])[]",
        }
        optional {
            schema "schema": String => "string",
            mode "mode": String => "'insert' | 'upsert'",
            key "key": Vec<String> => "readonly string[]",
            stop_on_error "stopOnError": bool => "boolean",
            first "first": u64 => "number",
            confirm "confirm": bool => "boolean",
            workspace "workspace": String => "string",
        }
    }
}

payload! {
    /// `db.convert`: the `CREATE TABLE` of columns in the engine of a session, or in
    /// `targetDriver`'s.
    closed DbConvertPayload {
        required {
            session "session": String => "string",
            table "table": String => "string",
            columns "columns": Vec<Value> => "readonly { name: string; kind: string; typeName?: string; nullable?: boolean }[]",
        }
        optional {
            schema "schema": String => "string",
            source_driver "sourceDriver": String => "string",
            target_driver "targetDriver": String => "string",
            workspace "workspace": String => "string",
        }
    }
}

payload! {
    /// `db.copy`: a page of a query of one session written into a table of another; `sql`
    /// the first time, then the `cursor` it answered.
    closed DbCopyPayload {
        required {
            source "source": String => "string",
            target "target": String => "string",
            table "table": String => "string",
        }
        optional {
            sql "sql": String => "string",
            cursor "cursor": String => "string",
            schema "schema": String => "string",
            columns "columns": Vec<String> => "readonly string[]",
            mode "mode": String => "'insert' | 'upsert'",
            key "key": Vec<String> => "readonly string[]",
            stop_on_error "stopOnError": bool => "boolean",
            first "first": u64 => "number",
            page_rows "pageRows": u32 => "number",
            confirm "confirm": bool => "boolean",
            workspace "workspace": String => "string",
        }
    }
}

payload! {
    /// `db.search`: objects of a session's connection by name (`metadata`, the default), or a
    /// value in the data of `tables` (`data`; `confirm` on production).
    closed DbSearchPayload {
        required {
            session "session": String => "string",
            statement "statement": String => "string",
            text "text": String => "string",
        }
        optional {
            mode "mode": String => "'metadata' | 'data'",
            kinds "kinds": Vec<String> => "readonly string[]",
            code "code": bool => "boolean",
            schemas "schemas": Vec<String> => "readonly string[]",
            max "max": u32 => "number",
            tables "tables": Vec<Value> => "readonly { schema?: string; name: string; path?: readonly string[] }[]",
            case_sensitive "caseSensitive": bool => "boolean",
            whole_word "wholeWord": bool => "boolean",
            columns "columns": Vec<String> => "readonly ('text' | 'number')[]",
            max_rows "maxRows": u32 => "number",
            confirm "confirm": bool => "boolean",
            workspace "workspace": String => "string",
        }
    }
}

payload! {
    /// `db.ddl.model`: the model of the table at `path` and the types of its engine (no
    /// path: the types alone, for a new table).
    closed DbDdlModelPayload {
        required {
            session "session": String => "string",
        }
        optional {
            path "path": Vec<String> => "readonly string[]",
            workspace "workspace": String => "string",
        }
    }
}

payload! {
    /// `db.ddl.plan`: the statements that make `target` of `original` (no original: create;
    /// no target: drop). Nothing runs.
    closed DbDdlPlanPayload {
        required {
            session "session": String => "string",
        }
        optional {
            original "original": Value => "unknown",
            target "target": Value => "unknown",
            cascade "cascade": bool => "boolean",
            workspace "workspace": String => "string",
        }
    }
}

payload! {
    /// `db.transactions`: the sessions of a workspace with a transaction open.
    closed DbTransactionsPayload {
        required {}
        optional { workspace "workspace": String => "string" }
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
