//! Inbound HTTP adapter. Contains transport concerns, no persistence or process code.
//!
//! Nexo serves one person on their own computer. Requests are accepted only on loopback,
//! from allowed origins and with either the per-run token (desktop shell, development
//! proxy, CLI tools) or a session cookie obtained through a one-time link.

mod access;
mod routes;
mod sessions;

#[cfg(test)]
use access::constant_time_eq;
use access::{api_headers, authenticate, cookie, loopback_host, page_headers, token_matches};
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
use routes::{
    create_workspace, delete_document, delete_workspace, document, documents, execute, git, health,
    mcp, mcp_stream, put_secret, remove_secret, rename_workspace, revisions, save_document,
    secrets, workspaces,
};
use serde::Deserialize;
use serde_json::{Value, json};
pub use sessions::Sessions;
use sessions::{close_session, issue_link, open_session};
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
        // Requests may bring the files they send (up to 32 MB, in base64).
        .route(
            "/execute/{operation}",
            post(execute).layer(DefaultBodyLimit::max(48 * 1024 * 1024)),
        )
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

#[cfg(test)]
mod tests;
