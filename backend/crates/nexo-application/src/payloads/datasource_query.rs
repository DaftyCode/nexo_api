//! Payloads of what reads SQL without running it (`db.query.*`), of test data (`db.mock.*`)
//! and of saved tasks (`db.task.*`).
use super::*;

payload! {
    /// `db.query.parse`: the model of the visual query builder of a `SELECT` (DB-26), or what
    /// it has that the model cannot hold; nothing runs.
    closed DbQueryParsePayload {
        required { sql "sql": String => "string" }
        optional {
            dialect "dialect": String => "string",
            workspace "workspace": String => "string",
        }
    }
}

payload! {
    /// `db.mock.rows`: a batch of test data for a table (DB-27), shown or, with `write`,
    /// written; rows `first` to `first + count - 1` of the run with `seed`.
    closed DbMockRowsPayload {
        required {
            session "session": String => "string",
            table "table": String => "string",
            columns "columns": Vec<Value> => "readonly Record<string, unknown>[]",
            seed "seed": u64 => "number",
            first "first": u64 => "number",
            count "count": u32 => "number",
        }
        optional {
            schema "schema": String => "string",
            write "write": bool => "boolean",
            workspace "workspace": String => "string",
        }
    }
}

payload! {
    /// `db.task.run`: runs a saved database task now (DB-31) and answers its run.
    closed DbTaskRunPayload {
        required { id "id": String => "string" }
        optional { workspace "workspace": String => "string" }
    }
}
