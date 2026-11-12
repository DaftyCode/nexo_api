//! Authorization payloads: OAuth 1.0 and 2.0 tokens and sign-in, and the cookie jar.
use super::*;

payload! {
    /// A cookie of a jar: its domain, path and name identify it.
    closed CookieKey {
        required {
            domain "domain": String => "string",
            path "path": String => "string",
            name "name": String => "string",
        }
        optional {}
    }
}

payload! {
    /// `cookies.set`: adds a cookie to the workspace jar, or replaces the `original` one when
    /// it is edited. Without `expires` (milliseconds since 1970) it is a session cookie, kept
    /// until it is deleted.
    closed CookieSetPayload {
        required {
            name "name": String => "string",
            value "value": String => "string",
            domain "domain": String => "string",
        }
        optional {
            workspace "workspace": String => "string",
            path "path": String => "string",
            expires "expires": u64 => "number",
            include_subdomains "includeSubdomains": bool => "boolean",
            secure "secure": bool => "boolean",
            http_only "httpOnly": bool => "boolean",
            same_site "sameSite": String => "'Strict' | 'Lax' | 'None'",
            original "original": CookieKey => "CookieKey",
        }
    }
}

payload! {
    /// `cookies.delete`: one cookie of the workspace jar.
    closed CookieDeletePayload {
        required {
            domain "domain": String => "string",
            path "path": String => "string",
            name "name": String => "string",
        }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `oauth2.token`: "Get New Access Token" for an authorization, or a refresh with `tokenId`.
    closed Oauth2TokenPayload {
        required {}
        optional {
            workspace "workspace": String => "string",
            token_id "tokenId": String => "string",
            request "request": Map<String, Value> => "object",
            item "item": Map<String, Value> => "object",
            collection "collection": Map<String, Value> => "object",
            variables "variables": Vec<VariableRow> => "readonly VariableRow[]",
            globals "globals": Vec<VariableRow> => "readonly VariableRow[]",
            context "context": ExecutionContext => "ExecutionContext",
        }
    }
}

payload! {
    /// `oauth2.authorize`: a browser sign-in. `start` takes the authorization like
    /// `oauth2.token`; the other actions take its `session`, and `complete` the `url` the
    /// browser returned to.
    closed Oauth2AuthorizePayload {
        required {}
        optional {
            workspace "workspace": String => "string",
            action "action": SignInAction => "'start' | 'status' | 'open' | 'complete' | 'cancel'",
            session "session": String => "string",
            url "url": String => "string",
            open_browser "openBrowser": bool => "boolean",
            request "request": Map<String, Value> => "object",
            item "item": Map<String, Value> => "object",
            collection "collection": Map<String, Value> => "object",
            variables "variables": Vec<VariableRow> => "readonly VariableRow[]",
            globals "globals": Vec<VariableRow> => "readonly VariableRow[]",
            context "context": ExecutionContext => "ExecutionContext",
        }
    }
}

payload! {
    /// `oauth2.tokens`: "Manage Tokens" (`list`, `details` or `delete` of the token `id`), or
    /// `add` a token the person pasted, under `name`.
    closed Oauth2TokensPayload {
        required {}
        optional {
            workspace "workspace": String => "string",
            action "action": TokensAction => "'list' | 'details' | 'delete' | 'add'",
            id "id": String => "string",
            name "name": String => "string",
            access_token "accessToken": String => "string",
            refresh_token "refreshToken": String => "string",
            id_token "idToken": String => "string",
            expires_in "expiresIn": u64 => "number",
        }
    }
}

payload! {
    /// `oauth.token`: posts form `fields` to a token endpoint.
    closed OauthTokenPayload {
        required { url "url": String => "string" }
        optional {
            workspace "workspace": String => "string",
            fields "fields": Map<String, Value> => "Record<string, unknown>",
            headers "headers": Value => "Record<string, string> | readonly object[]",
        }
    }
}

/// What an `oauth2.authorize` call does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SignInAction {
    Start,
    Status,
    Open,
    Complete,
    Cancel,
}

/// What an `oauth2.tokens` call does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TokensAction {
    List,
    Details,
    Delete,
    Add,
}
