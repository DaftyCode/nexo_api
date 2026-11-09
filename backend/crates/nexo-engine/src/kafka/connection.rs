//! One connection to a Kafka broker: TCP through the egress policy, TLS with the engine's
//! aws-lc-rs configuration, the API versions both sides support, SASL, and length-prefixed
//! requests matched to their answers by correlation id.
use super::{Settings, invalid, sasl};
use bytes::{Bytes, BytesMut};
use kafka_protocol::{
    messages::{
        ApiKey, ApiVersionsRequest, RequestHeader, ResponseHeader, SaslAuthenticateRequest,
        SaslHandshakeRequest,
    },
    protocol::{Decodable, Encodable, HeaderVersion, Request, StrBytes},
};
use nexo_domain::Result;
use std::{collections::HashMap, time::Duration};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// The largest answer read: a fetch is asked for at most a few megabytes.
const MAX_FRAME: usize = 64 * 1024 * 1024;
/// `UNSUPPORTED_VERSION`: an `ApiVersions` request newer than the broker knows.
const UNSUPPORTED_VERSION: i16 = 35;

trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}

pub struct Connection {
    stream: Box<dyn Stream>,
    correlation: i32,
    /// The versions the broker supports, by API key.
    versions: HashMap<i16, (i16, i16)>,
    client_id: String,
    pub host: String,
}
impl Connection {
    /// Connects, negotiates the API versions and authenticates.
    pub async fn open(settings: &Settings, host: &str, port: u16) -> Result<Self> {
        settings.check_host(host)?;
        let addresses = settings
            .egress
            .resolve(host, port, &settings.loopback_ports)
            .await?;
        let tcp = tokio::time::timeout(
            CONNECT_TIMEOUT,
            tokio::net::TcpStream::connect(&addresses[..]),
        )
        .await
        .map_err(|_| invalid(format!("Connecting to {host}:{port} timed out")))?
        .map_err(|error| invalid(format!("Cannot connect to {host}:{port}: {error}")))?;
        let _ = tcp.set_nodelay(true);
        let stream: Box<dyn Stream> = match &settings.tls {
            Some(config) => {
                let name = rustls_pki_types::ServerName::try_from(host.to_string())
                    .map_err(|_| invalid(format!("Invalid broker name {host}")))?;
                let connector = tokio_rustls::TlsConnector::from(config.clone());
                let tls = tokio::time::timeout(CONNECT_TIMEOUT, connector.connect(name, tcp))
                    .await
                    .map_err(|_| invalid(format!("TLS with {host}:{port} timed out")))?
                    .map_err(|error| invalid(format!("TLS with {host}:{port} failed: {error}")))?;
                Box::new(tls)
            }
            None => Box::new(tcp),
        };
        let mut connection = Self {
            stream,
            correlation: 0,
            versions: HashMap::new(),
            client_id: settings.client_id.clone(),
            host: host.to_string(),
        };
        connection.negotiate().await?;
        if let Some(credentials) = &settings.sasl {
            connection.authenticate(credentials).await?;
        }
        Ok(connection)
    }

    /// `ApiVersions`, with v3 and, from brokers that do not know it, v0.
    async fn negotiate(&mut self) -> Result<()> {
        let mut request = ApiVersionsRequest::default();
        request.client_software_name = StrBytes::from_static_str("nexo");
        request.client_software_version = StrBytes::from_static_str(env!("CARGO_PKG_VERSION"));
        let mut response = self.call_version(&request, 3).await?;
        if response.error_code == UNSUPPORTED_VERSION {
            response = self.call_version(&request, 0).await?;
        }
        if response.error_code != 0 {
            return Err(error_of(response.error_code, None));
        }
        self.versions = response
            .api_keys
            .iter()
            .map(|key| (key.api_key, (key.min_version, key.max_version)))
            .collect();
        Ok(())
    }

    async fn authenticate(&mut self, credentials: &super::Sasl) -> Result<()> {
        let mut handshake = SaslHandshakeRequest::default();
        handshake.mechanism = StrBytes::from_static_str(credentials.mechanism.name());
        let answer = self.call(&handshake, 1).await?;
        if answer.error_code != 0 {
            let accepted: Vec<String> = answer.mechanisms.iter().map(|m| m.to_string()).collect();
            return Err(invalid(format!(
                "The broker does not accept {}; it accepts {}",
                credentials.mechanism.name(),
                if accepted.is_empty() {
                    "none".to_string()
                } else {
                    accepted.join(", ")
                }
            )));
        }
        match credentials.mechanism {
            sasl::Mechanism::Plain => {
                self.sasl_step(sasl::plain(&credentials.username, &credentials.password))
                    .await?;
            }
            mechanism => {
                let mut scram = sasl::Scram::new(
                    mechanism,
                    &credentials.username,
                    &credentials.password,
                    sasl::nonce(),
                );
                let server_first = self.sasl_step(scram.client_first().into_bytes()).await?;
                let last = scram.client_final(&String::from_utf8_lossy(&server_first))?;
                let server_final = self.sasl_step(last.into_bytes()).await?;
                scram.verify(&String::from_utf8_lossy(&server_final))?;
            }
        }
        Ok(())
    }
    async fn sasl_step(&mut self, message: Vec<u8>) -> Result<Bytes> {
        let mut request = SaslAuthenticateRequest::default();
        request.auth_bytes = Bytes::from(message);
        let answer = self.call(&request, 2).await?;
        if answer.error_code != 0 {
            return Err(error_of(
                answer.error_code,
                answer.error_message.as_ref().map(|m| m.to_string()),
            ));
        }
        Ok(answer.auth_bytes)
    }

    /// The newest version both sides support, up to `cap` (the newest Nexo has checked).
    fn version<R: Request>(&self, cap: i16) -> Result<i16> {
        let name = ApiKey::try_from(R::KEY)
            .map(|key| format!("{key:?}"))
            .unwrap_or_else(|_| R::KEY.to_string());
        let (broker_min, broker_max) = self
            .versions
            .get(&R::KEY)
            .copied()
            .ok_or_else(|| invalid(format!("The broker does not support {name}")))?;
        let version = broker_max.min(R::VERSIONS.max).min(cap);
        if version < broker_min.max(R::VERSIONS.min) {
            return Err(invalid(format!(
                "No version of {name} is common to the broker and Nexo"
            )));
        }
        Ok(version)
    }

    /// Sends a request with the newest common version up to `cap`, and reads its answer.
    pub async fn call<R: Request>(&mut self, request: &R, cap: i16) -> Result<R::Response> {
        let version = self.version::<R>(cap)?;
        self.call_version(request, version).await
    }

    async fn call_version<R: Request>(&mut self, request: &R, version: i16) -> Result<R::Response> {
        self.correlation = self.correlation.wrapping_add(1);
        let correlation = self.correlation;
        let mut header = RequestHeader::default();
        header.request_api_key = R::KEY;
        header.request_api_version = version;
        header.correlation_id = correlation;
        header.client_id = Some(StrBytes::from_string(self.client_id.clone()));
        let mut body = BytesMut::new();
        header
            .encode(&mut body, R::header_version(version))
            .map_err(protocol)?;
        request.encode(&mut body, version).map_err(protocol)?;
        let exchange = async {
            self.stream.write_i32(body.len() as i32).await?;
            self.stream.write_all(&body).await?;
            self.stream.flush().await?;
            let length = self.stream.read_i32().await?;
            if length < 0 || length as usize > MAX_FRAME {
                return Err(std::io::Error::other("The broker sent an oversized answer"));
            }
            let mut frame = vec![0u8; length as usize];
            self.stream.read_exact(&mut frame).await?;
            Ok(Bytes::from(frame))
        };
        let mut frame = tokio::time::timeout(REQUEST_TIMEOUT, exchange)
            .await
            .map_err(|_| invalid(format!("{} did not answer in time", self.host)))?
            .map_err(|error| invalid(format!("Connection to {} failed: {error}", self.host)))?;
        let answer = ResponseHeader::decode(&mut frame, R::Response::header_version(version))
            .map_err(protocol)?;
        if answer.correlation_id != correlation {
            return Err(invalid("The broker answered another request"));
        }
        R::Response::decode(&mut frame, version).map_err(protocol)
    }
}

fn protocol(error: anyhow::Error) -> nexo_domain::Error {
    invalid(format!("Kafka protocol error: {error}"))
}

/// A Kafka error code as its name and description.
pub fn error_of(code: i16, message: Option<String>) -> nexo_domain::Error {
    use kafka_protocol::error::ParseResponseErrorCode;
    let known = code
        .err()
        .map(|error| format!("{error:?}: {error}"))
        .unwrap_or_else(|| format!("Kafka error {code}"));
    match message.filter(|m| !m.trim().is_empty()) {
        Some(message) => invalid(format!("{known} ({message})")),
        None => invalid(known),
    }
}
