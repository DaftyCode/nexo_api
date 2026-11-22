//! The `rest` extension (DB-36): a request to the HTTP API of an engine that has one
//! (Elasticsearch, OpenSearch), always to a path of the node the connection opened, never to
//! another host.
use crate::{DriverError, Result};
use serde::{Deserialize, Serialize};

/// The name of the extension in `capabilities.extensions`.
pub const EXTENSION: &str = "rest";

pub mod methods {
    pub const REQUEST: &str = "rest.request";
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct RestRequest {
    pub connection: String,
    /// `GET`, `POST`, `PUT`, `DELETE`, `HEAD` or `PATCH`.
    pub method: String,
    /// A path of the node, with its query: `idx/_search?size=5`.
    pub path: String,
    /// The body: JSON, or the lines of `_bulk` and `_msearch` as text.
    pub body: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RestResponse {
    pub status: u16,
    pub content_type: Option<String>,
    /// JSON when the answer is JSON; its text otherwise.
    pub body: serde_json::Value,
    pub elapsed_ms: u64,
}

/// The methods a request may use.
pub const METHODS: [&str; 6] = ["GET", "POST", "PUT", "DELETE", "HEAD", "PATCH"];

/// A path of the node, checked: relative (an absolute URL, `//host` or a scheme is refused),
/// without `..` or `.` segments (written or escaped), backslashes or control characters.
/// Answers it with one leading `/`, so nothing in it can name another host.
pub fn relative_path(path: &str) -> Result<String> {
    let refused = |why: &str| Err(DriverError::invalid(format!("{why}: {path}")));
    let trimmed = path.trim();
    if trimmed.chars().any(|c| c.is_control() || c == '\\') {
        return refused("A path has no control characters nor backslashes");
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.contains("://")
        || trimmed.starts_with("//")
        || lower.starts_with("http:")
        || lower.starts_with("https:")
    {
        return refused("The path is relative to the node of the connection");
    }
    let (route, _) = trimmed.split_once('?').unwrap_or((trimmed, ""));
    let decoded = route
        .replace("%2e", ".")
        .replace("%2E", ".")
        .replace("%2f", "/")
        .replace("%2F", "/");
    if decoded
        .split('/')
        .any(|segment| segment == ".." || segment == ".")
    {
        return refused("A path does not leave the node");
    }
    Ok(format!("/{}", trimmed.trim_start_matches('/')))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_relative_paths_of_the_node_pass() {
        assert_eq!(relative_path("_cat/indices?v").unwrap(), "/_cat/indices?v");
        assert_eq!(relative_path("/idx/_search").unwrap(), "/idx/_search");
        // An id may hold an @: it stays in the path of the node.
        assert_eq!(
            relative_path("idx/_doc/ana@x.com").unwrap(),
            "/idx/_doc/ana@x.com"
        );
        assert_eq!(relative_path("").unwrap(), "/");
        // A query may hold what a path may not.
        assert_eq!(relative_path("_search?q=a..b").unwrap(), "/_search?q=a..b");
        for wrong in [
            "http://other:9200/_search",
            "HTTPS://other/",
            "//other/_search",
            "/../_search",
            "idx/%2e%2e/secret",
            "idx/%2E%2e%2Fx",
            "idx/./x",
            "idx\\x",
            "idx/\n_search",
        ] {
            assert!(relative_path(wrong).is_err(), "{wrong}");
        }
    }
}
