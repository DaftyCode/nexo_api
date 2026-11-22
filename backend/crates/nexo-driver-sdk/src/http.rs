//! HTTP for the drivers of engines whose API is HTTP (Elasticsearch, Apache Drill): each
//! request goes to a node the connection names (never one the server announces), at the
//! address the host resolved for it (`net.resolve`, also a local port of a tunnel), with TLS
//! checked against the node's own name. One connection per request.
use crate::{DriverError, ErrorCode, HostLink, Result, limits};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::Request;
use hyper_util::rt::TokioIo;
use rustls::ClientConfig;
use rustls_pki_types::ServerName;
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

/// Bytes an answer may have.
const MAX_BODY: usize = 64 << 20;

/// A node: `https://es1:9200`, or a name whose scheme the connection's TLS mode says.
#[derive(Debug, Clone, PartialEq)]
pub struct Node {
    pub tls: bool,
    pub host: String,
    pub port: u16,
}

/// The nodes written in a host field: `es1,es2:9201` or `https://es1:9200`.
pub fn nodes(host: &str, port: Option<u16>, tls: bool, default_port: u16) -> Vec<Node> {
    host.split(',')
        .map(str::trim)
        .filter(|node| !node.is_empty())
        .map(|node| {
            let (secure, rest) = match node.split_once("://") {
                Some((scheme, rest)) => (scheme.eq_ignore_ascii_case("https"), rest),
                None => (tls, node),
            };
            let rest = rest.split('/').next().unwrap_or_default();
            let (name, number) = match rest.rsplit_once(':') {
                Some((name, number)) if !name.contains(':') || name.ends_with(']') => {
                    (name, number.parse().ok())
                }
                _ => (rest, None),
            };
            Node {
                tls: secure,
                host: name.trim_matches(['[', ']']).to_owned(),
                port: number.or(port).unwrap_or(default_port),
            }
        })
        .collect()
}

/// What answered: its status, its headers and its body.
pub struct Answer {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Bytes,
}

impl Answer {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(each, _)| each.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
    pub fn json(&self) -> Result<serde_json::Value> {
        serde_json::from_slice(&self.body)
            .map_err(|error| DriverError::invalid(format!("The server answered no JSON: {error}")))
    }
}

/// A request: its method, path (with its query), headers and body.
pub struct Call<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub headers: Vec<(&'a str, String)>,
    pub body: Option<Vec<u8>>,
}

pub struct Client {
    link: HostLink,
    connection: String,
    nodes: Vec<Node>,
    tls: Option<Arc<ClientConfig>>,
}

fn network(error: impl std::fmt::Display) -> DriverError {
    DriverError::network(error.to_string())
}

impl Client {
    pub fn new(
        link: &HostLink,
        connection: &str,
        nodes: Vec<Node>,
        tls: Option<Arc<ClientConfig>>,
    ) -> Result<Self> {
        if nodes.is_empty() {
            return Err(DriverError::invalid("Write the address of a server"));
        }
        if nodes.iter().any(|node| node.tls) && tls.is_none() {
            return Err(DriverError::tls("TLS is not set up for an https:// server"));
        }
        Ok(Self {
            link: link.clone(),
            connection: connection.to_owned(),
            nodes,
            tls,
        })
    }

    /// Sends a request to the first node that answers. `path` is a path of the node.
    pub async fn send(&self, call: &Call<'_>) -> Result<Answer> {
        let mut last = DriverError::network("No server answered");
        for node in &self.nodes {
            match self.to(node, call).await {
                Ok(answer) => return Ok(answer),
                // A node that does not answer: the next one.
                Err(error) if error.code == ErrorCode::Network => last = error,
                Err(error) => return Err(error),
            }
        }
        Err(last)
    }

    async fn to(&self, node: &Node, call: &Call<'_>) -> Result<Answer> {
        let addresses = self
            .link
            .resolve(&self.connection, &node.host, node.port)
            .await?;
        let mut stream = None;
        for address in &addresses {
            if let Ok(Ok(open)) =
                tokio::time::timeout(limits::connect(), TcpStream::connect(address)).await
            {
                stream = Some(open);
                break;
            }
        }
        let stream = stream.ok_or_else(|| {
            DriverError::network(format!("{}:{} did not answer", node.host, node.port))
        })?;
        let host = if matches!(node.port, 80 | 443) {
            node.host.clone()
        } else {
            format!("{}:{}", node.host, node.port)
        };
        let mut request = Request::builder()
            .method(call.method)
            .uri(call.path)
            .header(hyper::header::HOST, host);
        for (name, value) in &call.headers {
            request = request.header(*name, value);
        }
        let request = request
            .body(Full::new(Bytes::from(
                call.body.clone().unwrap_or_default(),
            )))
            .map_err(|error| DriverError::invalid(error.to_string()))?;
        let exchange = async {
            if node.tls {
                let config = self
                    .tls
                    .clone()
                    .ok_or_else(|| DriverError::tls("TLS is not set up"))?;
                let name = ServerName::try_from(node.host.clone())
                    .map_err(|error| DriverError::tls(error.to_string()))?;
                let secured = TlsConnector::from(config)
                    .connect(name, stream)
                    .await
                    .map_err(|error| DriverError::tls(error.to_string()))?;
                exchange(TokioIo::new(secured), request).await
            } else {
                exchange(TokioIo::new(stream), request).await
            }
        };
        tokio::time::timeout(limits::STATEMENT, exchange)
            .await
            .map_err(|_| DriverError::timeout("The server took too long to answer"))?
    }
}

async fn exchange<T>(io: TokioIo<T>, request: Request<Full<Bytes>>) -> Result<Answer>
where
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut sender, connection) = hyper::client::conn::http1::handshake(io)
        .await
        .map_err(network)?;
    tokio::spawn(connection);
    let response = sender.send_request(request).await.map_err(network)?;
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            Some((name.as_str().to_owned(), value.to_str().ok()?.to_owned()))
        })
        .collect();
    let body = Limited::new(response.into_body(), MAX_BODY)
        .collect()
        .await
        .map_err(|error| DriverError::invalid(format!("The answer could not be read: {error}")))?
        .to_bytes();
    Ok(Answer {
        status,
        headers,
        body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nodes_are_read_with_their_scheme_and_port() {
        let node = |tls, host: &str, port| Node {
            tls,
            host: host.into(),
            port,
        };
        assert_eq!(
            nodes("es1, https://es2:9201/x , [::1]:9300", None, false, 9200),
            [
                node(false, "es1", 9200),
                node(true, "es2", 9201),
                node(false, "::1", 9300)
            ]
        );
        assert_eq!(nodes("d", Some(8048), true, 8047), [node(true, "d", 8048)]);
        assert!(nodes(" , ", None, false, 1).is_empty());
    }
}
