//! Bearer Token (postman-runtime `bearer.js`): `Authorization: Bearer <token>`, nothing
//! without a token. Insomnia's `prefix` replaces `Bearer`; an empty prefix sends the token.
use nexo_domain::Result;
use serde_json::{Map, Value};

use super::{Outgoing, text};

pub fn sign(auth: &Map<String, Value>, request: &mut Outgoing) -> Result<()> {
    let token = text(auth.get("token").or_else(|| auth.get("accessToken")));
    if token.is_empty() {
        return Ok(());
    }
    let prefix = match auth.get("prefix") {
        None | Some(Value::Null) => "Bearer ".to_string(),
        Some(value) => match text(Some(value)).trim() {
            "" => String::new(),
            prefix => format!("{prefix} "),
        },
    };
    request
        .headers
        .set("authorization", &format!("{prefix}{token}"));
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::auth::tests::signed;
    use serde_json::json;

    #[test]
    fn sends_the_token_with_its_prefix_and_nothing_without_one() {
        let bearer = |rows: serde_json::Value| json!({"type": "bearer", "bearer": rows});
        let (_, headers) = signed(bearer(json!([{"key": "token", "value": "t"}])), "https://x");
        assert_eq!(headers.get("authorization"), vec!["Bearer t"]);
        let (_, headers) = signed(
            bearer(json!([{"key": "token", "value": "t"}, {"key": "prefix", "value": "Token"}])),
            "https://x",
        );
        assert_eq!(headers.get("authorization"), vec!["Token t"]);
        let (_, headers) = signed(bearer(json!([{"key": "token", "value": ""}])), "https://x");
        assert_eq!(headers.get("authorization"), vec!["Basic old"]);
    }
}
