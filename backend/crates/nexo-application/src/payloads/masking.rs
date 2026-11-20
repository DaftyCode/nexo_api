//! Payload of data masking: what a set of rules makes of documents or rows.
use super::*;

payload! {
    /// `mask.apply`: `documents` (any JSON values) or the `rows` of a table with its
    /// `columns`, masked with the `masking` document `set` of the workspace or with `rules`
    /// not saved yet. Rows come back with the positions of the columns kept (`kept`).
    closed MaskApplyPayload {
        required { workspace "workspace": String => "string" }
        optional {
            set "set": String => "string",
            rules "rules": Vec<Value> => "readonly { path: string; method: string; keep?: number }[]",
            documents "documents": Vec<Value> => "readonly unknown[]",
            columns "columns": Vec<String> => "readonly string[]",
            rows "rows": Vec<Value> => "readonly (readonly unknown[])[]",
        }
    }
}
