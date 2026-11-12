//! The browser sign-in: where the server sends the person back, PKCE, the authorization
//! URL and what comes back.
use super::*;

/// Nexo's callback page, the counterpart of Postman's `https://oauth.pstmn.io/v1/browser-callback`.
/// It forwards the provider's answer to the one-time port on this computer named in `state`.
pub const RELAY_URL: &str = "https://daftycode.github.io/nexo_api/oauth/callback";

/// How the provider's answer comes back to Nexo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Callback {
    /// The Callback URL is on this computer: Nexo listens on it.
    Loopback(Url),
    /// "Authorize using browser": Nexo's callback page forwards the answer to a local port.
    Relay,
    /// Any other Callback URL: the user pastes the address the browser returned to.
    Manual(Url),
}

pub(super) fn enabled(auth: &Map<String, Value>, key: &str) -> bool {
    matches!(auth.get(key), Some(Value::Bool(true))) || text(auth.get(key)) == "true"
}

/// Whether a grant type signs in through the browser.
pub fn uses_browser(auth: &Map<String, Value>) -> bool {
    matches!(
        grant(auth).as_str(),
        "authorization_code" | "authorization_code_with_pkce" | "implicit"
    )
}

/// The callback mode, as Postman's options map to Nexo: "Authorize using browser" uses Nexo's
/// callback page; otherwise the Callback URL decides.
pub fn callback(auth: &Map<String, Value>) -> Result<Callback> {
    if enabled(auth, "useBrowser") {
        return Ok(Callback::Relay);
    }
    let redirect = non_empty(auth, "redirect_uri")
        .ok_or_else(|| invalid("Enter the Callback URL or select Authorize using browser"))?;
    let url = Url::parse(&redirect)
        .map_err(|_| invalid(format!("The Callback URL is not valid: {redirect}")))?;
    let loopback = url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    Ok(if loopback {
        Callback::Loopback(url)
    } else {
        Callback::Manual(url)
    })
}

/// The PKCE code verifier: the one entered, or a new random one (RFC 7636).
pub fn pkce_verifier(auth: &Map<String, Value>, random: &[u8]) -> Result<Option<String>> {
    if grant(auth) != "authorization_code_with_pkce" {
        return Ok(None);
    }
    match non_empty(auth, "code_verifier") {
        Some(verifier) => {
            let valid = (43..=128).contains(&verifier.len())
                && verifier
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b));
            if !valid {
                return Err(invalid(
                    "The Code Verifier must have 43 to 128 letters, digits or - . _ ~",
                ));
            }
            Ok(Some(verifier))
        }
        None => Ok(Some(URL_SAFE_NO_PAD.encode(random))),
    }
}

/// The PKCE `(code_challenge, code_challenge_method)` for a verifier.
pub fn pkce_challenge(auth: &Map<String, Value>, verifier: &str) -> (String, &'static str) {
    if text(auth.get("challengeAlgorithm")).eq_ignore_ascii_case("plain") {
        (verifier.to_string(), "plain")
    } else {
        (
            URL_SAFE_NO_PAD.encode(digest::digest(&digest::SHA256, verifier.as_bytes())),
            "S256",
        )
    }
}

/// The address that starts the sign-in in the browser.
pub fn authorization_url(
    auth: &Map<String, Value>,
    redirect_uri: &str,
    state: &str,
    challenge: Option<&(String, &'static str)>,
    nonce: Option<&str>,
) -> Result<Url> {
    let address = non_empty(auth, "authUrl").ok_or_else(|| invalid("Enter the Auth URL"))?;
    let mut url = Url::parse(&address)
        .map_err(|_| invalid(format!("The Auth URL is not valid: {address}")))?;
    if !["http", "https"].contains(&url.scheme()) {
        return Err(invalid("The Auth URL must use HTTP or HTTPS"));
    }
    let response_type = if grant(auth) == "implicit" {
        non_empty(auth, "responseType").unwrap_or_else(|| "token".into())
    } else {
        "code".into()
    };
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("response_type", &response_type);
        query.append_pair("client_id", &text(auth.get("clientId")));
        query.append_pair("redirect_uri", redirect_uri);
        for key in ["scope", "audience", "resource"] {
            if let Some(value) = non_empty(auth, key) {
                query.append_pair(key, &value);
            }
        }
        query.append_pair("state", state);
        if let Some((code_challenge, method)) = challenge {
            query.append_pair("code_challenge", code_challenge);
            query.append_pair("code_challenge_method", method);
        }
        if let Some(nonce) = nonce.filter(|_| response_type.contains("id_token")) {
            query.append_pair("nonce", nonce);
        }
        // Headers cannot be sent through a browser, so every custom parameter goes in the URL.
        for row in auth
            .get("authRequestParams")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let key = text(row.get("key")).trim().to_string();
            if !key.is_empty() && row["enabled"] != false && row["disabled"] != true {
                query.append_pair(&key, &text(row.get("value")));
            }
        }
    }
    Ok(url)
}

/// What came back to the redirect URI.
#[derive(Debug, PartialEq)]
pub enum Returned {
    /// An authorization code to exchange for a token.
    Code(String),
    /// A token, from the implicit grant.
    Token(Value),
}

/// Reads the parameters the provider returned, in the query or (implicit grant) the
/// fragment, and checks that `state` is the one this sign-in sent.
pub fn read_return(
    query: &[(String, String)],
    expected_state: &str,
    now_ms: u64,
) -> Result<Returned> {
    let fields: Map<String, Value> = query
        .iter()
        .map(|(k, v)| (k.clone(), Value::String(v.clone())))
        .collect();
    let get = |key: &str| {
        fields
            .get(key)
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
    };
    if let Some(error) = get("error") {
        let description = get("error_description")
            .map(|d| format!(": {d}"))
            .unwrap_or_default();
        return Err(invalid(format!(
            "The sign-in was refused ({error}){description}"
        )));
    }
    if get("state").unwrap_or("") != expected_state {
        return Err(invalid(
            "The answer does not belong to this sign-in (state mismatch)",
        ));
    }
    if let Some(code) = get("code") {
        return Ok(Returned::Code(code.to_string()));
    }
    token_fields(200, &fields, now_ms).map(Returned::Token)
}

/// The query and fragment parameters of an address the browser returned to.
pub fn returned_parameters(url: &Url) -> Vec<(String, String)> {
    let mut parameters: Vec<(String, String)> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    if let Some(fragment) = url.fragment() {
        parameters.extend(
            url::form_urlencoded::parse(fragment.as_bytes())
                .map(|(k, v)| (k.into_owned(), v.into_owned())),
        );
    }
    parameters
}
