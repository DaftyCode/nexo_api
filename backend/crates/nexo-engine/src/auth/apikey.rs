//! API Key (postman-runtime `apikey.js`): nothing without a key or a value; otherwise the
//! header or query parameter of the same name is replaced. Placement is Postman's `in`
//! (`header`, `query`), Bruno's `placement` (`queryparams`) or Insomnia's `addTo`.
use nexo_domain::Result;
use serde_json::{Map, Value};

use super::{Outgoing, text};

fn in_query(auth: &Map<String, Value>) -> bool {
    ["in", "placement", "addTo"]
        .iter()
        .map(|key| text(auth.get(*key)).to_lowercase())
        .any(|place| place == "query" || place == "queryparams")
}

pub fn sign(auth: &Map<String, Value>, request: &mut Outgoing) -> Result<()> {
    let key = text(auth.get("key"));
    let value = text(auth.get("value"));
    if key.is_empty() && value.is_empty() {
        return Ok(());
    }
    if in_query(auth) {
        let kept: Vec<(String, String)> = request
            .url
            .query_pairs()
            .filter(|(name, _)| name != key.as_str())
            .map(|(name, value)| (name.into_owned(), value.into_owned()))
            .collect();
        let mut query = request.url.query_pairs_mut();
        query.clear().extend_pairs(kept).append_pair(&key, &value);
    } else {
        request.headers.set(&key, &value);
        request.credential_headers.push(key.to_lowercase());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::auth::tests::signed;
    use serde_json::json;

    #[test]
    fn replaces_the_header_or_query_parameter_like_postman() {
        let key = |rows: serde_json::Value| json!({"type": "apikey", "apikey": rows});
        let (_, headers) = signed(
            key(json!([{"key": "key", "value": "X-Key"}, {"key": "value", "value": "k"}])),
            "https://x",
        );
        assert_eq!(headers.get("x-key"), vec!["k"]);
        let (url, _) = signed(
            key(json!([
                {"key": "key", "value": "api_key"},
                {"key": "value", "value": "new"},
                {"key": "in", "value": "query"}
            ])),
            "https://x/a?api_key=old&keep=1",
        );
        assert_eq!(url.query(), Some("keep=1&api_key=new"));
        // Bruno's placement.
        let (url, _) = signed(
            key(json!([
                {"key": "key", "value": "k"},
                {"key": "value", "value": "v"},
                {"key": "placement", "value": "queryparams"}
            ])),
            "https://x/a",
        );
        assert_eq!(url.query(), Some("k=v"));
        // Neither key nor value: nothing is added.
        let (url, headers) = signed(key(json!([])), "https://x/a");
        assert_eq!(url.query(), None);
        assert_eq!(headers.get("authorization"), vec!["Basic old"]);
    }
}
