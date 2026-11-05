//! Basic Auth (postman-runtime `basic.js`): `Authorization: Basic base64(username:password)`,
//! UTF-8 like Postman, or ISO-8859-1 with Insomnia's `useISO88591` option.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use nexo_domain::Result;
use serde_json::{Map, Value};

use super::{Outgoing, flag, text};

pub fn sign(auth: &Map<String, Value>, request: &mut Outgoing) -> Result<()> {
    let credentials = format!(
        "{}:{}",
        text(auth.get("username")),
        text(auth.get("password"))
    );
    let bytes: Vec<u8> = if flag(auth, "useISO88591") {
        // Characters outside ISO-8859-1 cannot be encoded there and become "?".
        credentials
            .chars()
            .map(|c| u8::try_from(u32::from(c)).unwrap_or(b'?'))
            .collect()
    } else {
        credentials.into_bytes()
    };
    request.headers.set(
        "authorization",
        &format!("Basic {}", STANDARD.encode(bytes)),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::auth::tests::signed;
    use serde_json::json;

    #[test]
    fn encodes_utf8_by_default_and_latin1_on_request() {
        let basic = |extra: serde_json::Value| {
            let mut rows = vec![
                json!({"key": "username", "value": "José"}),
                json!({"key": "password", "value": "ñ€"}),
            ];
            if !extra.is_null() {
                rows.push(extra);
            }
            json!({"type": "basic", "basic": rows})
        };
        let (_, headers) = signed(basic(serde_json::Value::Null), "https://x");
        assert_eq!(headers.get("authorization"), vec!["Basic Sm9zw6k6w7Higqw="]);
        let (_, headers) = signed(
            basic(json!({"key": "useISO88591", "value": true})),
            "https://x",
        );
        // "José:ñ?" in ISO-8859-1: € has no code there.
        assert_eq!(headers.get("authorization"), vec!["Basic Sm9z6TrxPw=="]);
    }
}
