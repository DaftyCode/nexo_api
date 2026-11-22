//! What a request of the API of Elasticsearch or OpenSearch does (DB-36), by its method and
//! path: the rules of a connection hold for the console as they do for SQL. `GET`, `HEAD`
//! and the `POST`s of a closed list of endpoints that search read; anything else writes.
//! Deleting an index, `_delete_by_query`, `_update_by_query` and closing an index are
//! confirmed by typing what they name, a wildcard included.
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RequestKind {
    Read,
    Write,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestClass {
    pub kind: RequestKind,
    /// What must be typed to send it: the index (or pattern) it deletes, empties or closes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirm: Option<String>,
}

/// The endpoints whose `POST` only reads, by their first segments.
const READS: &[&str] = &[
    "_search",
    "_msearch",
    "_count",
    "_sql",
    "_explain",
    "_validate",
    "_field_caps",
    "_analyze",
    "_mget",
    "_render",
    "_termvectors",
    "_mtermvectors",
    "_rank_eval",
    "_knn_search",
    "_eql",
    "_query",
    "_pit",
    "_async_search",
    "_cat",
    "_mapping",
    "_settings",
    "_stats",
];

/// Endpoints of plugins of OpenSearch that only read.
const PLUGIN_READS: &[&str] = &["_sql", "_ppl"];

/// The segments of a path without its query, empty ones left out.
fn segments(path: &str) -> Vec<&str> {
    let route = path.split('?').next().unwrap_or_default();
    route
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect()
}

/// What a request does.
pub fn classify_request(method: &str, path: &str) -> RequestClass {
    let method = method.trim().to_ascii_uppercase();
    let parts = segments(path);
    let endpoint = parts.iter().position(|segment| segment.starts_with('_'));
    let target = || parts[..endpoint.unwrap_or(parts.len())].join("/");
    let read = |kind| RequestClass {
        kind,
        confirm: None,
    };
    let first = endpoint.map(|at| parts[at]).unwrap_or_default();
    let second = endpoint
        .and_then(|at| parts.get(at + 1))
        .copied()
        .unwrap_or_default();
    match method.as_str() {
        "GET" | "HEAD" => read(RequestKind::Read),
        // Freeing a scroll or a point in time changes nothing.
        "DELETE" if matches!((first, second), ("_search", "scroll") | ("_pit", _)) => {
            read(RequestKind::Read)
        }
        "DELETE" if endpoint.is_none() && !parts.is_empty() => RequestClass {
            kind: RequestKind::Write,
            confirm: Some(target()),
        },
        "DELETE" if first == "_data_stream" && !second.is_empty() => RequestClass {
            kind: RequestKind::Write,
            confirm: Some(second.to_owned()),
        },
        "POST" if matches!(first, "_delete_by_query" | "_update_by_query" | "_close") => {
            let named = target();
            RequestClass {
                kind: RequestKind::Write,
                confirm: Some(if named.is_empty() {
                    "_all".into()
                } else {
                    named
                }),
            }
        }
        "POST" if READS.contains(&first) => read(RequestKind::Read),
        "POST" if first == "_plugins" && PLUGIN_READS.contains(&second) => read(RequestKind::Read),
        _ => read(RequestKind::Write),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_read_or_write_by_their_method_and_endpoint() {
        use RequestKind::*;
        for (method, path, kind, confirm) in [
            ("GET", "_cat/indices?v", Read, None),
            ("head", "/shop", Read, None),
            ("POST", "shop/_search", Read, None),
            ("POST", "/shop,logs-*/_count?q=a", Read, None),
            ("POST", "_msearch", Read, None),
            ("POST", "_sql?format=json", Read, None),
            ("POST", "_sql/translate", Read, None),
            ("POST", "_plugins/_sql", Read, None),
            ("POST", "shop/_validate/query", Read, None),
            ("DELETE", "_search/scroll", Read, None),
            ("POST", "shop/_doc", Write, None),
            ("PUT", "shop", Write, None),
            ("POST", "_bulk", Write, None),
            ("POST", "_plugins/_security/api/x", Write, None),
            ("POST", "_snapshot/repo/_mount", Write, None),
            ("DELETE", "shop/_doc/1", Write, None),
            ("DELETE", "/shop", Write, Some("shop")),
            ("DELETE", "logs-*", Write, Some("logs-*")),
            ("DELETE", "_data_stream/logs", Write, Some("logs")),
            ("POST", "shop/_delete_by_query", Write, Some("shop")),
            ("POST", "_update_by_query", Write, Some("_all")),
            ("POST", "shop/_close", Write, Some("shop")),
            ("PATCH", "x", Write, None),
        ] {
            let class = classify_request(method, path);
            assert_eq!(class.kind, kind, "{method} {path}");
            assert_eq!(class.confirm.as_deref(), confirm, "{method} {path}");
        }
    }
}
