//! Who may call the API: loopback hosts, allowed origins, the per-run token or a session,
//! and the security headers of every answer.
use super::*;

pub(super) async fn api_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}
/// Security headers for every response, including the web interface files.
pub(super) async fn page_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
        ),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}
pub(super) fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .fold(0u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}
pub(super) fn header_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}
pub(super) fn bearer(headers: &HeaderMap) -> Option<&str> {
    header_value(headers, "authorization").and_then(|x| x.strip_prefix("Bearer "))
}
pub(super) fn cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value)
}
/// Only loopback Host headers: protects against DNS rebinding from other web pages.
pub(super) fn loopback_host(headers: &HeaderMap) -> bool {
    let host = header_value(headers, "host").unwrap_or("");
    host.starts_with("localhost:") || host.starts_with("127.0.0.1:") || host.starts_with("[::1]:")
}
pub(super) fn allowed_origin(state: &HttpState, headers: &HeaderMap) -> bool {
    header_value(headers, "origin").is_none_or(|origin| {
        state
            .access
            .allowed_origins
            .iter()
            .any(|allowed| allowed == origin)
    })
}
pub(super) fn token_matches(state: &HttpState, headers: &HeaderMap) -> bool {
    let supplied = bearer(headers).or_else(|| header_value(headers, "x-nexo-local-token"));
    supplied.is_some_and(|token| constant_time_eq(token.as_bytes(), state.access.token.as_bytes()))
}
pub(super) async fn authenticate(
    State(state): State<HttpState>,
    request: Request,
    next: Next,
) -> Response {
    let headers = request.headers();
    if !loopback_host(headers) || !allowed_origin(&state, headers) {
        return ApiError(Error::Unauthorized).into_response();
    }
    // The cookie is only accepted together with the client header, which other sites cannot
    // send without a CORS preflight that this service rejects.
    let cookie_session = cookie(headers, SESSION_COOKIE).is_some_and(|session| {
        state.sessions.valid(session) && header_value(headers, "x-nexo-client") == Some("nexo")
    });
    if !(token_matches(&state, headers) || cookie_session) {
        return ApiError(Error::Unauthorized).into_response();
    }
    next.run(request).await
}
