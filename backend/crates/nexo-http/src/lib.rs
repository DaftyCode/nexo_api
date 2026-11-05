//! Inbound HTTP adapter. Contains transport concerns, no persistence or process code.
//!
//! Nexo serves one person on their own computer. Requests are accepted only on loopback,
//! from allowed origins and with either the per-run token (desktop shell, development
//! proxy, CLI tools) or a session cookie obtained through a one-time link.
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Query, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post, put},
};
use nexo_application::{
    Application,
    operations::{GitOperation, Operation},
};
use nexo_domain::{Document, DocumentId, DocumentKind, Error, WorkspaceId};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tower_http::{
    cors::CorsLayer,
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

/// How the interface reaches the service.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// The Tauri window, authenticated with the per-run token.
    Desktop,
    /// A browser on the same computer, authenticated with a session cookie.
    Web,
}
impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Desktop => "desktop",
            Self::Web => "web",
        }
    }
}

#[derive(Clone)]
pub struct AccessConfig {
    pub mode: Mode,
    /// Secret for the desktop shell and local tools; never sent to the browser.
    pub token: String,
    pub allowed_origins: Vec<String>,
    /// Built web interface served in web mode.
    pub web_root: Option<PathBuf>,
}

const SESSION_COOKIE: &str = "nexo_session";
const LINK_LIFETIME: Duration = Duration::from_secs(120);
const SESSION_LIFETIME: Duration = Duration::from_secs(60 * 60 * 12);

fn random_secret() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// One-time sign-in links and the browser sessions created from them.
#[derive(Default)]
pub struct Sessions {
    links: Mutex<HashMap<String, Instant>>,
    sessions: Mutex<HashMap<String, Instant>>,
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
    fn redeem(&self, code: &str) -> Option<String> {
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
    fn valid(&self, session: &str) -> bool {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session)
            .is_some_and(|expires| *expires > Instant::now())
    }
    fn close(&self, session: &str) {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(session);
    }
}

#[derive(Clone)]
struct HttpState {
    application: Arc<Application>,
    access: AccessConfig,
    sessions: Arc<Sessions>,
}

pub struct ApiError(Error);
impl From<Error> for ApiError {
    fn from(error: Error) -> Self {
        Self(error)
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code, message) = match &self.0 {
            Error::Validation(message) => (StatusCode::BAD_REQUEST, "validation", message.clone()),
            Error::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized", self.0.to_string()),
            Error::NotFound => (StatusCode::NOT_FOUND, "not_found", self.0.to_string()),
            Error::Conflict => (StatusCode::CONFLICT, "conflict", self.0.to_string()),
            Error::Unavailable(message) => (
                StatusCode::SERVICE_UNAVAILABLE,
                "unavailable",
                message.clone(),
            ),
            Error::Infrastructure(error) => {
                tracing::error!(%error, "Adapter failure");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal",
                    "An internal operation failed".into(),
                )
            }
        };
        (status, Json(json!({"error":message,"code":code}))).into_response()
    }
}
type ApiResult<T> = std::result::Result<Json<T>, ApiError>;

pub fn router(
    application: Arc<Application>,
    access: AccessConfig,
    sessions: Arc<Sessions>,
) -> Router {
    let origins: Vec<HeaderValue> = access
        .allowed_origins
        .iter()
        .filter_map(|x| x.trim().parse().ok())
        .collect();
    let cors = CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::HeaderName::from_static("x-nexo-client"),
            header::HeaderName::from_static("mcp-session-id"),
        ]);
    let web_root = access.web_root.clone();
    let state = HttpState {
        application,
        access,
        sessions,
    };
    let protected = Router::new()
        .route("/session/close", post(close_session))
        .route("/workspaces", get(workspaces).post(create_workspace))
        .route(
            "/workspaces/{workspace}",
            put(rename_workspace).delete(delete_workspace),
        )
        .route("/documents", get(documents).put(save_document))
        .route("/documents/{id}", get(document).delete(delete_document))
        .route("/documents/{id}/revisions", get(revisions))
        .route("/execute/{operation}", post(execute))
        .route("/git/{operation}", post(git))
        .route("/secrets", get(secrets))
        .route("/secrets/{name}", put(put_secret).delete(remove_secret))
        .route("/mcp", post(mcp).get(mcp_stream))
        .route_layer(middleware::from_fn_with_state(state.clone(), authenticate));
    let api = Router::new()
        .route("/health", get(health))
        .route("/session/open", get(open_session))
        .route("/session/link", post(issue_link))
        .merge(protected)
        .layer(middleware::from_fn(api_headers))
        .layer(DefaultBodyLimit::max(16 * 1024 * 1024))
        .layer(cors);
    let mut app = Router::new().nest("/api", api);
    if let Some(root) = web_root {
        // Angular routes such as /workspace are resolved by the browser.
        let index = root.join("index.html");
        app = app.fallback_service(ServeDir::new(root).fallback(ServeFile::new(index)));
    }
    let request_id = header::HeaderName::from_static("x-request-id");
    // Spans carry the method, the path (never the query, which may hold a sign-in code) and
    // a request id that is also returned to the client.
    let trace = TraceLayer::new_for_http().make_span_with(|request: &axum::http::Request<_>| {
        let id = request
            .headers()
            .get("x-request-id")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        tracing::info_span!("request", method = %request.method(), path = %request.uri().path(), id)
    });
    app.layer(middleware::from_fn(page_headers))
        .layer(trace)
        .layer(PropagateRequestIdLayer::new(request_id.clone()))
        .layer(SetRequestIdLayer::new(request_id, MakeRequestUuid))
        .with_state(state)
}

async fn api_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}
/// Security headers for every response, including the web interface files.
async fn page_headers(request: Request, next: Next) -> Response {
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
fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .fold(0u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}
fn header_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}
fn bearer(headers: &HeaderMap) -> Option<&str> {
    header_value(headers, "authorization").and_then(|x| x.strip_prefix("Bearer "))
}
fn cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
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
fn loopback_host(headers: &HeaderMap) -> bool {
    let host = header_value(headers, "host").unwrap_or("");
    host.starts_with("localhost:") || host.starts_with("127.0.0.1:") || host.starts_with("[::1]:")
}
fn allowed_origin(state: &HttpState, headers: &HeaderMap) -> bool {
    header_value(headers, "origin").is_none_or(|origin| {
        state
            .access
            .allowed_origins
            .iter()
            .any(|allowed| allowed == origin)
    })
}
fn token_matches(state: &HttpState, headers: &HeaderMap) -> bool {
    let supplied = bearer(headers).or_else(|| header_value(headers, "x-nexo-local-token"));
    supplied.is_some_and(|token| constant_time_eq(token.as_bytes(), state.access.token.as_bytes()))
}
async fn authenticate(State(state): State<HttpState>, request: Request, next: Next) -> Response {
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
async fn health(State(state): State<HttpState>) -> Json<Value> {
    Json(json!({
        "name":"Nexo API",
        "version":env!("CARGO_PKG_VERSION"),
        "mode":state.access.mode.as_str(),
        "engineReady":state.application.engine_healthy().await,
    }))
}
#[derive(Deserialize)]
struct OpenQuery {
    code: String,
}
/// Exchanges a one-time link for an HttpOnly session cookie and opens the workspace.
async fn open_session(
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
async fn issue_link(State(state): State<HttpState>, headers: HeaderMap) -> ApiResult<Value> {
    if !loopback_host(&headers) || !token_matches(&state, &headers) {
        return Err(ApiError(Error::Unauthorized));
    }
    Ok(Json(
        json!({"path": format!("/api/session/open?code={}", state.sessions.issue_link())}),
    ))
}
async fn close_session(State(state): State<HttpState>, headers: HeaderMap) -> Response {
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
fn workspace_id(value: &str) -> Result<WorkspaceId, ApiError> {
    WorkspaceId::parse(value).map_err(ApiError)
}
fn document_id(value: &str) -> Result<DocumentId, ApiError> {
    DocumentId::parse(value).map_err(ApiError)
}
async fn workspaces(State(state): State<HttpState>) -> ApiResult<Vec<nexo_domain::Workspace>> {
    Ok(Json(state.application.workspaces().await?))
}
async fn create_workspace(
    State(state): State<HttpState>,
    Json(payload): Json<Value>,
) -> ApiResult<nexo_domain::Workspace> {
    Ok(Json(
        state
            .application
            .create_workspace(payload["name"].as_str().unwrap_or(""))
            .await?,
    ))
}
async fn rename_workspace(
    State(state): State<HttpState>,
    Path(workspace): Path<String>,
    Json(payload): Json<Value>,
) -> ApiResult<nexo_domain::Workspace> {
    Ok(Json(
        state
            .application
            .rename_workspace(
                &workspace_id(&workspace)?,
                payload["name"].as_str().unwrap_or(""),
            )
            .await?,
    ))
}
async fn delete_workspace(
    State(state): State<HttpState>,
    Path(workspace): Path<String>,
) -> ApiResult<Value> {
    state
        .application
        .delete_workspace(&workspace_id(&workspace)?)
        .await?;
    Ok(Json(json!({"deleted":true})))
}
#[derive(Deserialize)]
struct DocumentQuery {
    workspace: String,
    kind: Option<String>,
    /// `true` lists documents without their values.
    #[serde(default)]
    summary: bool,
    /// `true` lists history and runs without their values.
    #[serde(default)]
    lite: bool,
}
async fn documents(
    State(state): State<HttpState>,
    Query(query): Query<DocumentQuery>,
) -> std::result::Result<Response, ApiError> {
    let workspace = workspace_id(&query.workspace)?;
    let kind = query.kind.as_deref().map(DocumentKind::parse).transpose()?;
    Ok(if query.lite && kind.is_none() {
        Json(state.application.listing(&workspace).await?).into_response()
    } else if query.summary {
        Json(state.application.summaries(&workspace, kind).await?).into_response()
    } else {
        Json(state.application.documents(&workspace, kind).await?).into_response()
    })
}
async fn document(State(state): State<HttpState>, Path(id): Path<String>) -> ApiResult<Document> {
    Ok(Json(state.application.document(&document_id(&id)?).await?))
}
async fn save_document(
    State(state): State<HttpState>,
    Json(document): Json<Document>,
) -> ApiResult<Document> {
    Ok(Json(state.application.save_document(document).await?))
}
#[derive(Deserialize)]
struct DeleteQuery {
    revision: i64,
}
async fn delete_document(
    State(state): State<HttpState>,
    Path(id): Path<String>,
    Query(query): Query<DeleteQuery>,
) -> ApiResult<Value> {
    state
        .application
        .delete_document(&document_id(&id)?, query.revision)
        .await?;
    Ok(Json(json!({"deleted":true})))
}
async fn revisions(
    State(state): State<HttpState>,
    Path(id): Path<String>,
) -> ApiResult<Vec<nexo_domain::Revision>> {
    Ok(Json(state.application.revisions(&document_id(&id)?).await?))
}
async fn execute(
    State(state): State<HttpState>,
    Path(operation): Path<String>,
    Json(payload): Json<Value>,
) -> ApiResult<Value> {
    Ok(Json(
        state
            .application
            .execute(Operation::parse(&operation)?, payload)
            .await?,
    ))
}
async fn git(
    State(state): State<HttpState>,
    Path(operation): Path<String>,
    Json(payload): Json<Value>,
) -> ApiResult<Value> {
    Ok(Json(
        state
            .application
            .git(GitOperation::parse(&operation)?, payload)
            .await?,
    ))
}
async fn secrets(State(state): State<HttpState>) -> ApiResult<Value> {
    let secrets = state.application.secrets().await?;
    let names: Vec<&str> = secrets.iter().map(|secret| secret.name.as_str()).collect();
    Ok(Json(json!({"names": names, "secrets": secrets})))
}
async fn put_secret(
    State(state): State<HttpState>,
    Path(name): Path<String>,
    Json(payload): Json<Value>,
) -> ApiResult<Value> {
    if payload.get("value").is_some_and(|value| !value.is_string()) {
        return Err(ApiError(Error::Validation(
            "A secret value must be text".into(),
        )));
    }
    let allowed_hosts = match payload.get("allowedHosts") {
        None => None,
        Some(Value::Array(items)) => Some(
            items
                .iter()
                .map(|item| item.as_str().map(String::from))
                .collect::<Option<Vec<_>>>()
                .ok_or_else(|| {
                    ApiError(Error::Validation(
                        "Allowed domains must be a list of text".into(),
                    ))
                })?,
        ),
        Some(_) => {
            return Err(ApiError(Error::Validation(
                "Allowed domains must be a list of text".into(),
            )));
        }
    };
    state
        .application
        .put_secret(&name, payload["value"].as_str(), allowed_hosts.as_deref())
        .await?;
    Ok(Json(json!({"saved":true})))
}
async fn remove_secret(
    State(state): State<HttpState>,
    Path(name): Path<String>,
) -> ApiResult<Value> {
    state.application.remove_secret(&name).await?;
    Ok(Json(json!({"deleted":true})))
}

/// Streamable HTTP transport without server-initiated streams.
async fn mcp_stream() -> Response {
    (
        StatusCode::METHOD_NOT_ALLOWED,
        [(header::ALLOW, "POST")],
        "This MCP server does not open server-initiated streams",
    )
        .into_response()
}
/// Moves MCP messages to the application; it answers them with its use cases.
async fn mcp(State(state): State<HttpState>, Json(payload): Json<Value>) -> Response {
    let reply = state.application.mcp(payload).await;
    let Some(body) = reply.body else {
        return StatusCode::ACCEPTED.into_response();
    };
    let mut response = Json(body).into_response();
    if let Some(id) = reply.session.and_then(|id| HeaderValue::from_str(&id).ok()) {
        response.headers_mut().insert("mcp-session-id", id);
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn links_work_once_and_create_sessions() {
        let sessions = Sessions::default();
        let code = sessions.issue_link();
        let session = sessions.redeem(&code).expect("first use");
        assert!(sessions.redeem(&code).is_none(), "links are single use");
        assert!(sessions.valid(&session));
        assert!(!sessions.valid("forged"));
        sessions.close(&session);
        assert!(!sessions.valid(&session));
    }
    #[test]
    fn parses_cookies_and_compares_tokens() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("a=1; nexo_session=abc"),
        );
        assert_eq!(cookie(&headers, SESSION_COOKIE), Some("abc"));
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
    }
}
