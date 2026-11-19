//! Read-only environments. While one is active the engine refuses every request that may
//! change data, wherever it comes from: the request sent, a collection run, a load test or
//! `nx.sendRequest` in a script. The application names the environment in
//! `readOnlyEnvironment`; the CLI does it from the environment file.
use nexo_domain::{Error, Result};
use serde_json::Value;

/// Methods that only read (RFC 9110, safe methods); any other may change data.
const SAFE: [&str; 4] = ["GET", "HEAD", "OPTIONS", "TRACE"];

/// Refuses `request` (collection format) when `environment` is read-only and it may change
/// data: a method that is not safe, or a GraphQL mutation even when sent with GET.
pub fn check(environment: Option<&str>, request: &Value) -> Result<()> {
    let Some(environment) = environment else {
        return Ok(());
    };
    let method = request["method"]
        .as_str()
        .unwrap_or("GET")
        .trim()
        .to_ascii_uppercase();
    let body = &request["body"];
    let graphql = body["mode"] == "graphql";
    if graphql {
        if mutation(body["graphql"]["query"].as_str().unwrap_or_default()) {
            return Err(Error::Validation(format!(
                "The environment «{environment}» is read-only: GraphQL mutations are not sent"
            )));
        }
        return Ok(());
    }
    if SAFE.contains(&method.as_str()) {
        return Ok(());
    }
    Err(Error::Validation(format!(
        "The environment «{environment}» is read-only: {method} requests are not sent"
    )))
}

/// Whether a GraphQL document defines a mutation. Comments and strings are skipped, so a
/// field or an argument that only mentions the word does not count.
pub fn mutation(document: &str) -> bool {
    let mut words = String::with_capacity(document.len());
    let mut chars = document.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '#' => {
                for next in chars.by_ref() {
                    if next == '\n' {
                        break;
                    }
                }
                words.push(' ');
            }
            '"' => {
                let mut escaped = false;
                for next in chars.by_ref() {
                    if escaped {
                        escaped = false;
                    } else if next == '\\' {
                        escaped = true;
                    } else if next == '"' {
                        break;
                    }
                }
                words.push(' ');
            }
            _ => words.push(c),
        }
    }
    // An operation starts at the top level, outside every selection set.
    let mut depth = 0usize;
    let mut word = String::new();
    for c in words.chars().chain(std::iter::once(' ')) {
        if c.is_alphanumeric() || c == '_' {
            word.push(c);
            continue;
        }
        if depth == 0 && word == "mutation" {
            return true;
        }
        word.clear();
        match c {
            '{' => depth += 1,
            '}' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn graphql(query: &str) -> Value {
        json!({"method": "POST", "body": {"mode": "graphql", "graphql": {"query": query}}})
    }

    #[test]
    fn a_read_only_environment_refuses_what_may_change_data() {
        let env = Some("Production");
        for method in ["GET", "head", "OPTIONS", "TRACE"] {
            assert!(check(env, &json!({"method": method})).is_ok(), "{method}");
        }
        assert!(check(env, &json!({})).is_ok());
        for method in ["POST", "put", "PATCH", "DELETE", "PURGE"] {
            let error = check(env, &json!({"method": method})).unwrap_err();
            assert_eq!(
                error.to_string(),
                format!(
                    "The environment «Production» is read-only: {} requests are not sent",
                    method.to_ascii_uppercase()
                )
            );
        }
        assert!(check(None, &json!({"method": "DELETE"})).is_ok());
    }

    #[test]
    fn graphql_queries_pass_and_mutations_do_not() {
        let env = Some("Production");
        assert!(check(env, &graphql("query Orders { orders { id } }")).is_ok());
        assert!(
            check(
                env,
                &graphql("{ orders(note: \"mutation\") { id mutation } }")
            )
            .is_ok()
        );
        assert!(check(env, &graphql("# mutation\n{ orders { id } }")).is_ok());
        let refused = check(env, &graphql("mutation { cancel(id: 1) { id } }")).unwrap_err();
        assert!(
            refused
                .to_string()
                .contains("GraphQL mutations are not sent")
        );
        assert!(mutation(
            "query A { a } mutation B($id: ID!) { b(id: $id) }"
        ));
        assert!(mutation("mutation{x}"));
        assert!(!mutation("subscription { mutationCount }"));
        // A GraphQL query sent with GET in the URL is a read; a raw POST is a write.
        assert!(check(env, &json!({"method": "POST", "body": {"mode": "raw"}})).is_err());
    }
}
