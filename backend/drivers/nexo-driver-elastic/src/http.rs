//! The HTTP API of the nodes, through the SDK's client: only the nodes the connection names
//! (no sniffing), with the connection's authorization.
use base64::Engine;
use nexo_driver_sdk::{
    DriverError, HostLink, Result,
    http::{self, Answer as Reply, Call},
    protocol::{ConnectParams, TlsMode, TlsSettings},
    tls,
};

/// What answered: its status, its media type and its body.
pub(crate) struct Answer {
    pub status: u16,
    pub content_type: Option<String>,
    pub body: bytes::Bytes,
}

impl Answer {
    pub fn json(&self) -> Result<serde_json::Value> {
        serde_json::from_slice(&self.body)
            .map_err(|error| DriverError::invalid(format!("The node answered no JSON: {error}")))
    }
}

impl From<Reply> for Answer {
    fn from(reply: Reply) -> Self {
        Self {
            status: reply.status,
            content_type: reply.header("content-type").map(str::to_owned),
            body: reply.body,
        }
    }
}

pub(crate) struct Client {
    http: http::Client,
    /// The `Authorization` header, with its secret.
    authorization: Option<String>,
}

impl Client {
    pub fn new(link: &HostLink, params: &ConnectParams) -> Result<Self> {
        let secure = params.tls.mode != TlsMode::Disable;
        let nodes = http::nodes(
            params.host.as_deref().unwrap_or("localhost"),
            params.port,
            secure,
            9200,
        );
        let tls = match tls::client_config(&params.tls)? {
            Some(config) => Some(config),
            // A node written with https:// on a connection without TLS checks the server.
            None if nodes.iter().any(|node| node.tls) => tls::client_config(&TlsSettings {
                mode: TlsMode::Verify,
                ..params.tls.clone()
            })?,
            None => None,
        };
        let secret = params.password.clone().unwrap_or_default();
        let user = params.user.clone().unwrap_or_default();
        let auth = params.options.get("auth").map(String::as_str).unwrap_or("");
        let authorization = match auth {
            "apiKey" => Some(format!("ApiKey {secret}")),
            "bearer" => Some(format!("Bearer {secret}")),
            "none" => None,
            "" | "basic" if !user.is_empty() => {
                let pair =
                    base64::engine::general_purpose::STANDARD.encode(format!("{user}:{secret}"));
                Some(format!("Basic {pair}"))
            }
            "" | "basic" => None,
            other => {
                return Err(DriverError::invalid(format!(
                    "Unknown authentication {other}: basic, apiKey, bearer or none"
                )));
            }
        };
        Ok(Self {
            http: http::Client::new(link, &params.connection, nodes, tls)?,
            authorization,
        })
    }

    /// Sends a request to the first node that answers, asking for JSON. `path` is already
    /// checked as relative.
    pub async fn send(
        &self,
        method: &str,
        path: &str,
        body: Option<(&str, Vec<u8>)>,
    ) -> Result<Answer> {
        self.send_as(method, path, body, true).await
    }

    /// Sends a request; without `json`, the server answers in its own format, as in the
    /// console of Kibana (`_cat` as a text table unless `format=json`).
    pub async fn send_as(
        &self,
        method: &str,
        path: &str,
        body: Option<(&str, Vec<u8>)>,
        json: bool,
    ) -> Result<Answer> {
        let mut headers = Vec::new();
        if json {
            headers.push(("accept", "application/json".to_owned()));
        }
        if let Some(authorization) = &self.authorization {
            headers.push(("authorization", authorization.clone()));
        }
        let body = body.map(|(media, bytes)| {
            headers.push(("content-type", media.to_owned()));
            bytes
        });
        let call = Call {
            method,
            path,
            headers,
            body,
        };
        Ok(self.http.send(&call).await?.into())
    }
}
