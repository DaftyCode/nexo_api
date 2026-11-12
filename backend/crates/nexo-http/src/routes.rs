//! The API routes: workspaces, documents, execution, Git, the vault and MCP.
use super::*;

pub(super) async fn health(State(state): State<HttpState>) -> Json<Value> {
    Json(json!({
        "name":"Nexo API",
        "version":env!("CARGO_PKG_VERSION"),
        "mode":state.access.mode.as_str(),
        "engineReady":state.application.engine_healthy().await,
    }))
}

pub(super) fn workspace_id(value: &str) -> Result<WorkspaceId, ApiError> {
    WorkspaceId::parse(value).map_err(ApiError)
}
pub(super) fn document_id(value: &str) -> Result<DocumentId, ApiError> {
    DocumentId::parse(value).map_err(ApiError)
}
pub(super) async fn workspaces(
    State(state): State<HttpState>,
) -> ApiResult<Vec<nexo_domain::Workspace>> {
    Ok(Json(state.application.workspaces().await?))
}
pub(super) async fn create_workspace(
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
pub(super) async fn rename_workspace(
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
pub(super) async fn delete_workspace(
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
pub(super) struct DocumentQuery {
    pub(super) workspace: String,
    pub(super) kind: Option<String>,
    /// `true` lists documents without their values.
    #[serde(default)]
    pub(super) summary: bool,
    /// `true` lists history and runs without their values.
    #[serde(default)]
    pub(super) lite: bool,
}
pub(super) async fn documents(
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
pub(super) async fn document(
    State(state): State<HttpState>,
    Path(id): Path<String>,
) -> ApiResult<Document> {
    Ok(Json(state.application.document(&document_id(&id)?).await?))
}
pub(super) async fn save_document(
    State(state): State<HttpState>,
    Json(document): Json<Document>,
) -> ApiResult<Document> {
    Ok(Json(state.application.save_document(document).await?))
}
#[derive(Deserialize)]
pub(super) struct DeleteQuery {
    pub(super) revision: i64,
}
pub(super) async fn delete_document(
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
pub(super) async fn revisions(
    State(state): State<HttpState>,
    Path(id): Path<String>,
) -> ApiResult<Vec<nexo_domain::Revision>> {
    Ok(Json(state.application.revisions(&document_id(&id)?).await?))
}
pub(super) async fn execute(
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
pub(super) async fn git(
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
pub(super) async fn secrets(State(state): State<HttpState>) -> ApiResult<Value> {
    let secrets = state.application.secrets().await?;
    let names: Vec<&str> = secrets.iter().map(|secret| secret.name.as_str()).collect();
    Ok(Json(json!({"names": names, "secrets": secrets})))
}
pub(super) async fn put_secret(
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
pub(super) async fn remove_secret(
    State(state): State<HttpState>,
    Path(name): Path<String>,
) -> ApiResult<Value> {
    state.application.remove_secret(&name).await?;
    Ok(Json(json!({"deleted":true})))
}

/// Streamable HTTP transport without server-initiated streams.
pub(super) async fn mcp_stream() -> Response {
    (
        StatusCode::METHOD_NOT_ALLOWED,
        [(header::ALLOW, "POST")],
        "This MCP server does not open server-initiated streams",
    )
        .into_response()
}
/// Moves MCP messages to the application; it answers them with its use cases.
pub(super) async fn mcp(State(state): State<HttpState>, Json(payload): Json<Value>) -> Response {
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
