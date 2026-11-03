//! Inbound HTTP adapter. Contains transport concerns, no persistence or process code.
use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, Path, Query, Request, State},
    http::{HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use nexo_application::Application;
use nexo_domain::{Actor, Credentials, Document, Error};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use tower_http::cors::CorsLayer;

#[derive(Clone)]
pub struct AccessConfig {
    pub mode: String,
    pub desktop_token: Option<String>,
    pub allow_signup: bool,
    pub allowed_origins: Vec<String>,
}
#[derive(Clone)]
struct HttpState {
    application: Arc<Application>,
    access: AccessConfig,
}
pub struct ApiError(Error);
impl From<Error> for ApiError {
    fn from(error: Error) -> Self {
        Self(error)
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, message) = match &self.0 {
            Error::Validation(message) => (StatusCode::BAD_REQUEST, message.clone()),
            Error::Unauthorized => (StatusCode::UNAUTHORIZED, self.0.to_string()),
            Error::Forbidden => (StatusCode::FORBIDDEN, self.0.to_string()),
            Error::NotFound => (StatusCode::NOT_FOUND, self.0.to_string()),
            Error::Conflict => (StatusCode::CONFLICT, self.0.to_string()),
            Error::Infrastructure(error) => {
                tracing::error!(%error,"Adapter failure");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "An internal operation failed".into(),
                )
            }
        };
        (status, Json(json!({"error":message}))).into_response()
    }
}
type ApiResult<T> = std::result::Result<Json<T>, ApiError>;
pub fn router(application: Arc<Application>, access: AccessConfig) -> Router {
    let origins: Vec<HeaderValue> = access
        .allowed_origins
        .iter()
        .filter_map(|x| x.parse().ok())
        .collect();
    let cors = CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::HeaderName::from_static("x-nexo-client"),
        ]);
    let state = HttpState {
        application,
        access,
    };
    let protected = Router::new()
        .route("/me", get(me))
        .route("/auth/logout", post(logout))
        .route("/workspaces", get(workspaces).post(create_workspace))
        .route(
            "/workspaces/{workspace}/members",
            get(members).post(add_member),
        )
        .route("/documents", get(documents).put(save_document))
        .route("/documents/{id}", get(document).delete(delete_document))
        .route("/documents/{id}/revisions", get(revisions))
        .route("/execute/{operation}", post(execute))
        .route("/git/{operation}", post(git))
        .route("/secrets/{name}", put(put_secret).delete(remove_secret))
        .route("/mcp", post(mcp))
        .route_layer(middleware::from_fn_with_state(state.clone(), authenticate));
    Router::new()
        .nest(
            "/api",
            Router::new()
                .route("/health", get(health))
                .route("/auth/register", post(register))
                .route("/auth/login", post(login))
                .merge(protected),
        )
        .layer(DefaultBodyLimit::max(16 * 1024 * 1024))
        .layer(cors)
        .with_state(state)
}
async fn authenticate(
    State(state): State<HttpState>,
    mut request: Request,
    next: Next,
) -> Response {
    let token = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|x| x.to_str().ok())
        .and_then(|x| x.strip_prefix("Bearer "))
        .unwrap_or("");
    if state.access.mode != "server" {
        let origin = request
            .headers()
            .get(header::ORIGIN)
            .and_then(|x| x.to_str().ok());
        let host = request
            .headers()
            .get(header::HOST)
            .and_then(|x| x.to_str().ok())
            .unwrap_or("");
        if !host.starts_with("localhost:")
            && !host.starts_with("127.0.0.1:")
            && !host.starts_with("[::1]:")
        {
            return ApiError(Error::Forbidden).into_response();
        }
        if origin.is_some_and(|o| {
            !state
                .access
                .allowed_origins
                .iter()
                .any(|allowed| allowed == o)
        }) {
            return ApiError(Error::Forbidden).into_response();
        }
        if let Some(expected) = &state.access.desktop_token {
            if token != expected {
                return ApiError(Error::Unauthorized).into_response();
            }
        } else if request
            .headers()
            .get("x-nexo-client")
            .and_then(|x| x.to_str().ok())
            != Some("nexo")
        {
            return ApiError(Error::Forbidden).into_response();
        }
        request.extensions_mut().insert(Actor::local());
    } else {
        match state.application.identity.resolve(token).await {
            Ok(actor) => {
                request.extensions_mut().insert(actor);
            }
            Err(error) => return ApiError(error).into_response(),
        }
    }
    next.run(request).await
}
async fn health(State(state): State<HttpState>) -> ApiResult<Value> {
    Ok(Json(
        json!({"name":"Nexo API","version":env!("CARGO_PKG_VERSION"),"mode":state.access.mode,"setupRequired":!state.application.identity.has_users().await?,"allowSignup":state.access.allow_signup,"engine":"nexo-runtime","capabilities":["http","graphql","grpc","websocket","socketio","mqtt","collections","environments","scripts","runner","import","codegen","mocks","datasets","git","mcp","vault","workspaces","revisions"]}),
    ))
}
async fn register(
    State(state): State<HttpState>,
    Json(credentials): Json<Credentials>,
) -> ApiResult<nexo_domain::Session> {
    Ok(Json(
        state
            .application
            .identity
            .register(credentials, state.access.allow_signup)
            .await?,
    ))
}
async fn login(
    State(state): State<HttpState>,
    Json(credentials): Json<Credentials>,
) -> ApiResult<nexo_domain::Session> {
    Ok(Json(state.application.identity.login(credentials).await?))
}
async fn me(Extension(actor): Extension<Actor>) -> Json<Actor> {
    Json(actor)
}
async fn logout(
    State(state): State<HttpState>,
    headers: axum::http::HeaderMap,
) -> ApiResult<Value> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|x| x.to_str().ok())
        .and_then(|x| x.strip_prefix("Bearer "))
        .unwrap_or("");
    state.application.identity.logout(token).await?;
    Ok(Json(json!({"ok":true})))
}
async fn workspaces(
    State(state): State<HttpState>,
    Extension(actor): Extension<Actor>,
) -> ApiResult<Vec<nexo_domain::Workspace>> {
    Ok(Json(state.application.workspaces.workspaces(&actor).await?))
}
async fn create_workspace(
    State(state): State<HttpState>,
    Extension(actor): Extension<Actor>,
    Json(payload): Json<Value>,
) -> ApiResult<nexo_domain::Workspace> {
    Ok(Json(
        state
            .application
            .workspaces
            .create_workspace(&actor, payload["name"].as_str().unwrap_or(""))
            .await?,
    ))
}
async fn members(
    State(state): State<HttpState>,
    Extension(actor): Extension<Actor>,
    Path(workspace): Path<String>,
) -> ApiResult<Value> {
    Ok(Json(
        state
            .application
            .workspaces
            .members(&actor, &workspace)
            .await?,
    ))
}
async fn add_member(
    State(state): State<HttpState>,
    Extension(actor): Extension<Actor>,
    Path(workspace): Path<String>,
    Json(payload): Json<Value>,
) -> ApiResult<Value> {
    state
        .application
        .workspaces
        .add_member(
            &actor,
            &workspace,
            payload["email"].as_str().unwrap_or(""),
            payload["role"].as_str().unwrap_or("viewer"),
        )
        .await?;
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
struct DocumentQuery {
    workspace: String,
    kind: Option<String>,
}
async fn documents(
    State(state): State<HttpState>,
    Extension(actor): Extension<Actor>,
    Query(query): Query<DocumentQuery>,
) -> ApiResult<Vec<Document>> {
    Ok(Json(
        state
            .application
            .workspaces
            .documents(&actor, &query.workspace, query.kind.as_deref())
            .await?,
    ))
}
async fn document(
    State(state): State<HttpState>,
    Extension(actor): Extension<Actor>,
    Path(id): Path<String>,
) -> ApiResult<Document> {
    Ok(Json(
        state.application.workspaces.document(&actor, &id).await?,
    ))
}
async fn save_document(
    State(state): State<HttpState>,
    Extension(actor): Extension<Actor>,
    Json(document): Json<Document>,
) -> ApiResult<Document> {
    Ok(Json(
        state.application.save_document(&actor, document).await?,
    ))
}
#[derive(Deserialize)]
struct DeleteQuery {
    revision: i64,
}
async fn delete_document(
    State(state): State<HttpState>,
    Extension(actor): Extension<Actor>,
    Path(id): Path<String>,
    Query(query): Query<DeleteQuery>,
) -> ApiResult<Value> {
    state
        .application
        .workspaces
        .delete(&actor, &id, query.revision)
        .await?;
    Ok(Json(json!({"deleted":true})))
}
async fn revisions(
    State(state): State<HttpState>,
    Extension(actor): Extension<Actor>,
    Path(id): Path<String>,
) -> ApiResult<Vec<nexo_domain::Revision>> {
    Ok(Json(
        state.application.workspaces.revisions(&actor, &id).await?,
    ))
}
async fn execute(
    State(state): State<HttpState>,
    Extension(actor): Extension<Actor>,
    Path(operation): Path<String>,
    Json(payload): Json<Value>,
) -> ApiResult<Value> {
    Ok(Json(
        state
            .application
            .execute(&actor, &operation, payload)
            .await?,
    ))
}
async fn git(
    State(state): State<HttpState>,
    Extension(actor): Extension<Actor>,
    Path(operation): Path<String>,
    Json(payload): Json<Value>,
) -> ApiResult<Value> {
    Ok(Json(
        state.application.git(&actor, &operation, payload).await?,
    ))
}
async fn put_secret(
    State(state): State<HttpState>,
    Extension(actor): Extension<Actor>,
    Path(name): Path<String>,
    Json(payload): Json<Value>,
) -> ApiResult<Value> {
    state
        .application
        .secrets
        .put(&actor, &name, payload["value"].as_str().unwrap_or(""))
        .await?;
    Ok(Json(json!({"saved":true})))
}
async fn remove_secret(
    State(state): State<HttpState>,
    Extension(actor): Extension<Actor>,
    Path(name): Path<String>,
) -> ApiResult<Value> {
    state.application.secrets.remove(&actor, &name).await?;
    Ok(Json(json!({"deleted":true})))
}
async fn mcp(
    State(state): State<HttpState>,
    Extension(actor): Extension<Actor>,
    Json(payload): Json<Value>,
) -> ApiResult<Value> {
    let id = payload["id"].clone();
    let result = match payload["method"].as_str().unwrap_or("") {
        "initialize" => {
            json!({"protocolVersion":"2025-03-26","serverInfo":{"name":"nexo-api","version":env!("CARGO_PKG_VERSION")},"capabilities":{"tools":{}}})
        }
        "tools/list" => {
            json!({"tools":[{"name":"send_request","description":"Execute an HTTP request using the Nexo runtime","inputSchema":{"type":"object","properties":{"request":{"type":"object"}},"required":["request"]}},{"name":"list_workspaces","description":"List your workspaces","inputSchema":{"type":"object","properties":{}}}]})
        }
        "tools/call" => {
            let p = &payload["params"];
            let value = match p["name"].as_str().unwrap_or("") {
                "send_request" => {
                    state
                        .application
                        .execute(&actor, "request", p["arguments"].clone())
                        .await?
                }
                "list_workspaces" => {
                    serde_json::to_value(state.application.workspaces.workspaces(&actor).await?)
                        .map_err(|e| ApiError(Error::Infrastructure(e.to_string())))?
                }
                _ => {
                    return Ok(Json(
                        json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Unknown tool"}}),
                    ));
                }
            };
            json!({"content":[{"type":"text","text":value.to_string()}]})
        }
        "notifications/initialized" => json!({}),
        _ => {
            return Ok(Json(
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Method not found"}}),
            ));
        }
    };
    Ok(Json(json!({"jsonrpc":"2.0","id":id,"result":result})))
}
