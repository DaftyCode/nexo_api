//! Payloads of comparing and synchronizing two databases (DB-24, `db.compare.*`, `db.sync.data`).
use super::*;

payload! {
    /// One side of a comparison of structure: a schema or database (its path in the tree)
    /// of a session, or a table (`table`).
    closed CompareSide {
        required {
            session "session": String => "string",
            path "path": Vec<String> => "readonly string[]",
        }
        optional { table "table": bool => "boolean" }
    }
}

payload! {
    /// One side of a comparison of data: a table of a session, by its path in the tree (for
    /// its model) and by its schema and name (for its rows).
    closed CompareTable {
        required {
            session "session": String => "string",
            path "path": Vec<String> => "readonly string[]",
            table "table": String => "string",
        }
        optional { schema "schema": String => "string" }
    }
}

payload! {
    /// `db.compare.schema`: what differs between the objects of two schemas or two tables
    /// (also of two engines), with what to leave out. `db.compare.script`: the DDL that makes
    /// the target like the source (`drop`: also dropping what only the target has; `tables`:
    /// only those), built with the target's driver; nothing runs.
    closed DbCompareSchemaPayload {
        required {
            source "source": CompareSide => "CompareSide",
            target "target": CompareSide => "CompareSide",
        }
        optional {
            workspace "workspace": String => "string",
            ignore_comments "ignoreComments": bool => "boolean",
            ignore_column_order "ignoreColumnOrder": bool => "boolean",
            ignore_constraint_names "ignoreConstraintNames": bool => "boolean",
            drop "drop": bool => "boolean",
            tables "tables": Vec<String> => "readonly string[]",
        }
    }
}

payload! {
    /// `db.compare.data`: the rows of two tables paired by `key` (the source's primary key
    /// when none), comparing their common columns but `ignore`, with an optional `filter`
    /// (a condition of both). `db.sync.data` writes what makes the target like the source
    /// (`delete`: also deleting what only the target has), with its table name typed
    /// (`confirmName`) and, on production, `confirm`; `script` writes the statements instead
    /// of running them. `statement` names its reads, to cancel them.
    closed DbCompareDataPayload {
        required {
            source "source": CompareTable => "CompareTable",
            target "target": CompareTable => "CompareTable",
        }
        optional {
            workspace "workspace": String => "string",
            key "key": Vec<String> => "readonly string[]",
            ignore "ignore": Vec<String> => "readonly string[]",
            filter "filter": String => "string",
            statement "statement": String => "string",
            delete "delete": bool => "boolean",
            confirm "confirm": bool => "boolean",
            confirm_name "confirmName": String => "string",
            script "script": bool => "boolean",
        }
    }
}
