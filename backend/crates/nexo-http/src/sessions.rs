//! Sessions of the web version: one-time links and the cookie they open.
use super::*;

/// One-time sign-in links and the browser sessions created from them.
#[derive(Default)]
pub struct Sessions {
    pub(super) links: Mutex<HashMap<String, Instant>>,
    pub(super) sessions: Mutex<HashMap<String, Instant>>,
}
impl Sessions {
    /// A code valid once for two minutes; open `/api/session/open?code=…` to use it.
    pub fn issue_link(&self) -> String {
        let code = random_secret();
        let mut links = self.links.lock().unwrap_or_else(|e| e.into_inner());
        links.retain(|_, expires| *expires > Instant::now());
        links.insert(code.clone(), Instant::now() + LINK_LIFETIME);
        code
    }
    pub(super) fn redeem(&self, code: &str) -> Option<String> {
        let mut links = self.links.lock().unwrap_or_else(|e| e.into_inner());
        let valid = links
            .remove(code)
            .is_some_and(|expires| expires > Instant::now());
        if !valid {
            return None;
        }
        let session = random_secret();
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions.retain(|_, expires| *expires > Instant::now());
        sessions.insert(session.clone(), Instant::now() + SESSION_LIFETIME);
        Some(session)
    }
    pub(super) fn valid(&self, session: &str) -> bool {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session)
            .is_some_and(|expires| *expires > Instant::now())
    }
    pub(super) fn close(&self, session: &str) {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(session);
    }
}

#[derive(Deserialize)]
pub(super) struct OpenQuery {
    pub(super) code: String,
}
/// Exchanges a one-time link for an HttpOnly session cookie and opens the workspace.
pub(super) async fn open_session(
    State(state): State<HttpState>,
    headers: HeaderMap,
    Query(query): Query<OpenQuery>,
) -> Response {
    if !loopback_host(&headers) {
        return ApiError(Error::Unauthorized).into_response();
    }
    match state.sessions.redeem(&query.code) {
        Some(session) => {
            let cookie = format!(
                "{SESSION_COOKIE}={session}; HttpOnly; SameSite=Strict; Path=/; Max-Age={}",
                SESSION_LIFETIME.as_secs()
            );
            let mut response = Redirect::to("/workspace").into_response();
            if let Ok(value) = HeaderValue::from_str(&cookie) {
                response.headers_mut().insert(header::SET_COOKIE, value);
            }
            response
        }
        None => (
            StatusCode::UNAUTHORIZED,
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            "This link was already used or expired. Run the Nexo launcher again to open a new one.",
        )
            .into_response(),
    }
}
/// A new one-time link for the launcher when the service is already running.
pub(super) async fn issue_link(
    State(state): State<HttpState>,
    headers: HeaderMap,
) -> ApiResult<Value> {
    if !loopback_host(&headers) || !token_matches(&state, &headers) {
        return Err(ApiError(Error::Unauthorized));
    }
    Ok(Json(
        json!({"path": format!("/api/session/open?code={}", state.sessions.issue_link())}),
    ))
}
pub(super) async fn close_session(State(state): State<HttpState>, headers: HeaderMap) -> Response {
    if let Some(session) = cookie(&headers, SESSION_COOKIE) {
        state.sessions.close(session);
    }
    let mut response = Json(json!({"ok":true})).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_static("nexo_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"),
    );
    response
}
