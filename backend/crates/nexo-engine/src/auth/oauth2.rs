//! OAuth 2.0 token placement (postman-runtime `oauth2.js`). Getting tokens is in
//! `crate::oauth2`; this only adds the current one to the request:
//! - nothing is added without an `accessToken`;
//! - `addTokenTo` is `header` by default, or `queryParams`;
//! - the header is `Authorization: <headerPrefix> <token>`. Without a `headerPrefix` the
//!   prefix is `Bearer`; a prefix is trimmed, and an empty one sends the bare token;
//! - MAC tokens are not signed, and leave the request untouched;
//! - otherwise any `Authorization` header and token query parameter are replaced.
use nexo_domain::Result;
use serde_json::{Map, Value};
use url::Url;

use super::{Outgoing, text};

/// The query parameter that carries the token in the URL. Postman always uses
/// `access_token`; Bruno lets it be renamed with `tokenQueryKey`.
fn query_key(auth: &Map<String, Value>) -> String {
    let key = text(auth.get("tokenQueryKey"));
    if key.trim().is_empty() {
        "access_token".into()
    } else {
        key
    }
}

pub fn sign(auth: &Map<String, Value>, request: &mut Outgoing) -> Result<()> {
    let token = text(auth.get("accessToken"));
    if token.is_empty() {
        return Ok(());
    }
    let add_to = match text(auth.get("addTokenTo")) {
        place if place.is_empty() => "header".to_string(),
        place => place,
    };
    if text(auth.get("tokenType")).eq_ignore_ascii_case("mac") {
        return Ok(());
    }
    let prefix = match auth.get("headerPrefix") {
        None | Some(Value::Null) => "Bearer ".to_string(),
        Some(value) => match text(Some(value)).trim() {
            "" => String::new(),
            prefix => format!("{prefix} "),
        },
    };
    let key = query_key(auth);
    request.headers.delete("authorization");
    remove_query(request.url, &key);
    match add_to.as_str() {
        "queryParams" => {
            request.url.query_pairs_mut().append_pair(&key, &token);
        }
        "header" => request
            .headers
            .set("authorization", &format!("{prefix}{token}")),
        _ => {}
    }
    Ok(())
}

fn remove_query(url: &mut Url, key: &str) {
    if url.query().is_none() {
        return;
    }
    let kept: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(name, _)| name != key)
        .map(|(name, value)| (name.into_owned(), value.into_owned()))
        .collect();
    if kept.is_empty() {
        url.set_query(None);
    } else {
        url.query_pairs_mut().clear().extend_pairs(kept);
    }
}

#[cfg(test)]
mod tests {
    use crate::auth::tests::signed;
    use serde_json::{Value, json};

    fn oauth2(rows: Value) -> Value {
        json!({"type": "oauth2", "oauth2": rows})
    }

    #[test]
    fn sends_the_token_like_postman() {
        let (_, headers) = signed(
            oauth2(json!([{"key": "accessToken", "value": "abc"}])),
            "https://x/a",
        );
        assert_eq!(headers.get("authorization"), vec!["Bearer abc"]);
        let (_, headers) = signed(
            oauth2(json!([
                {"key": "accessToken", "value": "abc"},
                {"key": "headerPrefix", "value": "  Token "}
            ])),
            "https://x/a",
        );
        assert_eq!(headers.get("authorization"), vec!["Token abc"]);
        let (_, headers) = signed(
            oauth2(json!([
                {"key": "accessToken", "value": "abc"},
                {"key": "headerPrefix", "value": ""}
            ])),
            "https://x/a",
        );
        assert_eq!(headers.get("authorization"), vec!["abc"]);
    }

    #[test]
    fn can_send_the_token_in_the_url_instead() {
        let (url, headers) = signed(
            oauth2(json!([
                {"key": "accessToken", "value": "a b"},
                {"key": "addTokenTo", "value": "queryParams"}
            ])),
            "https://x/a?access_token=old&keep=1",
        );
        assert!(headers.get("authorization").is_empty());
        assert_eq!(url.as_str(), "https://x/a?keep=1&access_token=a+b");
        let (url, _) = signed(
            oauth2(json!([
                {"key": "accessToken", "value": "t"},
                {"key": "addTokenTo", "value": "queryParams"},
                {"key": "tokenQueryKey", "value": "token"}
            ])),
            "https://x/a",
        );
        assert_eq!(url.as_str(), "https://x/a?token=t");
    }

    #[test]
    fn leaves_the_request_alone_without_a_token_or_with_a_mac_token() {
        for rows in [
            json!([]),
            json!([{"key": "accessToken", "value": "t"}, {"key": "tokenType", "value": "MAC"}]),
        ] {
            let (url, headers) = signed(oauth2(rows), "https://x/a?access_token=keep");
            assert_eq!(headers.get("authorization"), vec!["Basic old"]);
            assert_eq!(url.query(), Some("access_token=keep"));
        }
    }
}
