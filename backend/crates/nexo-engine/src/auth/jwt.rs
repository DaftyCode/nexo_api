//! JWT Bearer, as Postman signs it (postman-runtime `jwt.js` with `jose`): a token is built and
//! signed on every send from the JSON header and payload, after their variables are replaced.
//! The header keeps its keys and gets `alg` from the chosen algorithm; nothing else is added.
//!
//! HMAC (`HS*`) uses the secret, optionally Base64; RSA (`RS*`, `PS*`) and ECDSA (`ES*`) use a
//! PEM private key. Postman takes PKCS#8 keys; PKCS#1 RSA and SEC1 EC keys are accepted too.
use aws_lc_rs::{hmac, rand::SystemRandom, signature};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE, URL_SAFE_NO_PAD},
};
use nexo_domain::{Error, Result};
use rustls_pki_types::{PrivateKeyDer, pem::PemObject};
use serde_json::{Map, Value};

use super::{Outgoing, flag, text};

fn invalid(message: impl Into<String>) -> Error {
    Error::Validation(message.into())
}

/// The algorithms of Postman's JWT Bearer.
pub const ALGORITHMS: [&str; 12] = [
    "HS256", "HS384", "HS512", "RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256",
    "ES384", "ES512",
];

/// The key a token is signed with: the HMAC secret or the PEM private key.
pub enum SigningKey<'a> {
    Secret(&'a [u8]),
    PrivateKey(&'a str),
}

fn sign_hmac(algorithm: &str, secret: &[u8], message: &[u8]) -> Vec<u8> {
    let algorithm = match algorithm {
        "HS384" => hmac::HMAC_SHA384,
        "HS512" => hmac::HMAC_SHA512,
        _ => hmac::HMAC_SHA256,
    };
    hmac::sign(&hmac::Key::new(algorithm, secret), message)
        .as_ref()
        .to_vec()
}

fn sign_rsa(algorithm: &str, private_key: &str, message: &[u8]) -> Result<Vec<u8>> {
    let key = PrivateKeyDer::from_pem_slice(private_key.as_bytes())
        .map_err(|_| invalid("Invalid private key. Enter a valid key."))?;
    let pair = match &key {
        PrivateKeyDer::Pkcs8(der) => signature::RsaKeyPair::from_pkcs8(der.secret_pkcs8_der()),
        PrivateKeyDer::Pkcs1(der) => signature::RsaKeyPair::from_der(der.secret_pkcs1_der()),
        _ => return Err(invalid(format!("{algorithm} needs an RSA private key"))),
    }
    .map_err(|_| invalid(format!("{algorithm} needs an RSA private key")))?;
    let encoding: &'static dyn signature::RsaEncoding = match algorithm {
        "RS256" => &signature::RSA_PKCS1_SHA256,
        "RS384" => &signature::RSA_PKCS1_SHA384,
        "RS512" => &signature::RSA_PKCS1_SHA512,
        "PS256" => &signature::RSA_PSS_SHA256,
        "PS384" => &signature::RSA_PSS_SHA384,
        _ => &signature::RSA_PSS_SHA512,
    };
    let mut output = vec![0; pair.public_modulus_len()];
    pair.sign(encoding, &SystemRandom::new(), message, &mut output)
        .map_err(|_| invalid("Could not sign with the RSA key"))?;
    Ok(output)
}

fn sign_ecdsa(algorithm: &str, private_key: &str, message: &[u8]) -> Result<Vec<u8>> {
    let key = PrivateKeyDer::from_pem_slice(private_key.as_bytes())
        .map_err(|_| invalid("Invalid private key. Enter a valid key."))?;
    let curve = match algorithm {
        "ES256" => &signature::ECDSA_P256_SHA256_FIXED_SIGNING,
        "ES384" => &signature::ECDSA_P384_SHA384_FIXED_SIGNING,
        _ => &signature::ECDSA_P521_SHA512_FIXED_SIGNING,
    };
    let wrong_curve = || {
        let curve = match algorithm {
            "ES256" => "P-256",
            "ES384" => "P-384",
            _ => "P-521",
        };
        invalid(format!(
            "{algorithm} needs an EC private key on the {curve} curve"
        ))
    };
    let pair = match &key {
        PrivateKeyDer::Pkcs8(der) => {
            signature::EcdsaKeyPair::from_pkcs8(curve, der.secret_pkcs8_der())
        }
        PrivateKeyDer::Sec1(der) => {
            signature::EcdsaKeyPair::from_private_key_der(curve, der.secret_sec1_der())
        }
        _ => return Err(wrong_curve()),
    }
    .map_err(|_| wrong_curve())?;
    // JWS signatures are `r || s` (the fixed encoding), not DER.
    Ok(pair
        .sign(&SystemRandom::new(), message)
        .map_err(|_| invalid("Could not sign with the EC key"))?
        .as_ref()
        .to_vec())
}

/// A signed compact JWT: `header.payload.signature`, each Base64url without padding.
pub fn token(
    algorithm: &str,
    header: Map<String, Value>,
    payload: &Map<String, Value>,
    key: SigningKey,
) -> Result<String> {
    if !ALGORITHMS.contains(&algorithm) {
        return Err(invalid("invalid algorithm"));
    }
    let mut header = header;
    header.insert("alg".into(), Value::String(algorithm.into()));
    let encode = |value: &Map<String, Value>| {
        serde_json::to_vec(value)
            .map(|json| URL_SAFE_NO_PAD.encode(json))
            .map_err(|error| invalid(error.to_string()))
    };
    let signing_input = format!("{}.{}", encode(&header)?, encode(payload)?);
    let signature = match (&algorithm[..2], key) {
        ("HS", SigningKey::Secret(secret)) => {
            sign_hmac(algorithm, secret, signing_input.as_bytes())
        }
        ("RS" | "PS", SigningKey::PrivateKey(pem)) => {
            sign_rsa(algorithm, pem, signing_input.as_bytes())?
        }
        ("ES", SigningKey::PrivateKey(pem)) => {
            sign_ecdsa(algorithm, pem, signing_input.as_bytes())?
        }
        _ => return Err(invalid("invalid algorithm")),
    };
    Ok(format!(
        "{signing_input}.{}",
        URL_SAFE_NO_PAD.encode(signature)
    ))
}

/// A JSON object stored as text (or already as an object); blank text is an empty object.
fn object(value: Option<&Value>, what: &str) -> Result<Map<String, Value>> {
    match value {
        None | Some(Value::Null) => Ok(Map::new()),
        Some(Value::Object(object)) => Ok(object.clone()),
        Some(Value::String(text)) if text.trim().is_empty() => Ok(Map::new()),
        Some(Value::String(text)) => match serde_json::from_str(text.trim()) {
            Ok(Value::Object(object)) => Ok(object),
            Ok(_) => Err(invalid(format!("The JWT {what} must be a JSON object"))),
            Err(error) => Err(invalid(format!(
                "The JWT {what} is not valid JSON: {error}"
            ))),
        },
        Some(_) => Err(invalid(format!("The JWT {what} must be a JSON object"))),
    }
}

/// Node's lenient Base64 reading: standard or URL-safe, with or without padding.
fn decode_base64(text: &str) -> Result<Vec<u8>> {
    let text: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    let padded = format!("{text}{}", "=".repeat((4 - text.len() % 4) % 4));
    STANDARD
        .decode(&padded)
        .or_else(|_| URL_SAFE.decode(&padded))
        .map_err(|_| invalid("The JWT secret is not valid Base64"))
}

pub fn sign(auth: &Map<String, Value>, request: &mut Outgoing) -> Result<()> {
    let algorithm = match text(auth.get("algorithm")) {
        blank if blank.is_empty() => "HS256".to_string(),
        algorithm => algorithm,
    };
    if !ALGORITHMS.contains(&algorithm.as_str()) {
        return Err(invalid("invalid algorithm"));
    }
    let header = object(auth.get("header"), "header")?;
    let payload = object(auth.get("payload"), "payload")?;
    let jwt = if algorithm.starts_with("HS") {
        let secret = text(auth.get("secret"));
        if secret.is_empty() {
            return Err(invalid("Invalid secret key. Enter a valid key."));
        }
        let secret = if flag(auth, "isSecretBase64Encoded") {
            decode_base64(&secret)?
        } else {
            secret.into_bytes()
        };
        token(&algorithm, header, &payload, SigningKey::Secret(&secret))?
    } else {
        let private_key = text(auth.get("privateKey"));
        if private_key.trim().is_empty() {
            return Err(invalid("Invalid private key. Enter a valid key."));
        }
        token(
            &algorithm,
            header,
            &payload,
            SigningKey::PrivateKey(&private_key),
        )?
    };

    if text(auth.get("addTokenTo")) == "queryParam" {
        let name = match text(auth.get("queryParamKey")) {
            blank if blank.is_empty() => "token".to_string(),
            name => name,
        };
        let kept: Vec<(String, String)> = request
            .url
            .query_pairs()
            .filter(|(key, _)| key != name.as_str())
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        request
            .url
            .query_pairs_mut()
            .clear()
            .extend_pairs(kept)
            .append_pair(&name, &jwt);
    } else {
        // No prefix stored means "Bearer"; an empty one sends the bare token.
        let prefix = match auth.get("headerPrefix") {
            None | Some(Value::Null) => "Bearer".to_string(),
            Some(value) => text(Some(value)),
        };
        let value = if prefix.is_empty() {
            jwt
        } else {
            format!("{prefix} {jwt}")
        };
        request.headers.set("Authorization", &value);
        request.credential_headers.push("Authorization".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests;
