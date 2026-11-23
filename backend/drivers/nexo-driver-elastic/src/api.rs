//! Who answers at `/`, and a request of the API to a path of the node (`rest.request`).
use crate::{ElasticDriver, Flavour, catalog, http::Client};
use nexo_driver_sdk::{
    DriverError, Result,
    protocol::{ConnectParams, ServerInfo},
    rest::{self, RestRequest, RestResponse},
};
use serde_json::Value as Json;
use std::time::Instant;

/// Who answers at `/`: its engine, version and cluster.
pub(crate) async fn server(
    client: &Client,
    params: &ConnectParams,
) -> Result<(ServerInfo, Flavour)> {
    let root = catalog::get(client, "/").await?;
    let version = &root["version"];
    let flavour = if version["distribution"].as_str() == Some("opensearch") {
        Flavour::OpenSearch
    } else {
        Flavour::Elasticsearch
    };
    let product = match flavour {
        Flavour::Elasticsearch => "Elasticsearch",
        Flavour::OpenSearch => "OpenSearch",
    };
    let info = ServerInfo {
        server_version: version["number"].as_str().unwrap_or_default().to_owned(),
        product: Some(format!(
            "{product} ({})",
            root["cluster_name"].as_str().unwrap_or_default()
        )),
        database: None,
        user: params.user.clone().filter(|user| !user.is_empty()),
        tls: params.tls.mode != nexo_driver_sdk::protocol::TlsMode::Disable,
    };
    Ok((info, flavour))
}

impl ElasticDriver {
    /// A request of the API to a path of the node.
    pub(crate) async fn request(&self, request: RestRequest) -> Result<RestResponse> {
        let connection = self.connection(&request.connection)?;
        let method = request.method.trim().to_ascii_uppercase();
        if !rest::METHODS.contains(&method.as_str()) {
            return Err(DriverError::invalid(format!("Unknown method {method}")));
        }
        let path = rest::relative_path(&request.path)?;
        let body = request.body.map(|body| match body {
            // The lines of `_bulk` and `_msearch` go as they are written.
            Json::String(text) => (
                "application/x-ndjson",
                format!("{}\n", text.trim_end()).into_bytes(),
            ),
            other => ("application/json", other.to_string().into_bytes()),
        });
        let started = Instant::now();
        let answer = connection
            .client
            .send_as(&method, &path, body, false)
            .await?;
        let body = serde_json::from_slice(&answer.body)
            .unwrap_or_else(|_| Json::String(String::from_utf8_lossy(&answer.body).into_owned()));
        Ok(RestResponse {
            status: answer.status,
            content_type: answer.content_type,
            body,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }
}
