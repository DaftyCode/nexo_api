//! A session of HiveServer2 in HTTP mode: each call of `TCLIService` is a `POST` of a Thrift
//! message to the HTTP path (`/cliservice`), with the user and password as Basic
//! authentication and then the session's cookie, through the SDK's HTTP client (each node at
//! the address the host resolved, TLS with aws-lc-rs).
use crate::thrift::{self, Builder, Thrift};
use base64::Engine as _;
use nexo_driver_sdk::{
    DriverError, HostLink, Result,
    http::{self, Call},
    protocol::{ConnectParams, TlsMode},
    tls,
};
use std::{
    sync::{
        Mutex,
        atomic::{AtomicI32, Ordering},
    },
    time::Duration,
};

/// `HIVE_CLI_SERVICE_PROTOCOL_V10`: columnar row sets, which every Hive since 2.3 speaks.
const PROTOCOL: i32 = 9;
/// The HTTP path of HiveServer2 when the connection does not say another one.
pub const DEFAULT_PATH: &str = "/cliservice";
/// HiveServer2's HTTP port.
pub const DEFAULT_PORT: u16 = 10001;

pub struct Session {
    http: http::Client,
    path: String,
    authorization: Option<String>,
    cookie: Mutex<Option<String>>,
    handle: Mutex<Option<Thrift>>,
    sequence: AtomicI32,
    pub database: Option<String>,
}

/// A status of `TStatus` that is an error, with Hive's message.
pub fn check(answer: &Thrift) -> Result<()> {
    let status = answer.field(1);
    let code = status
        .and_then(|status| status.field(1))
        .and_then(Thrift::i32);
    match code {
        Some(0..=2) => Ok(()),
        _ => {
            let message = status
                .and_then(|status| status.field(5))
                .and_then(Thrift::string)
                .unwrap_or_else(|| "HiveServer2 answered with an error".into());
            Err(failure(
                &message,
                status.and_then(|s| s.field(3)).and_then(Thrift::string),
            ))
        }
    }
}

/// Hive's message as an error of the SDK: a compile error is a syntax error.
pub fn failure(message: &str, state: Option<String>) -> DriverError {
    let first = message.lines().next().unwrap_or(message).to_owned();
    if first.contains("ParseException") || state.as_deref() == Some("42000") {
        DriverError::syntax(first)
    } else if first.contains("Permission denied") || first.contains("not authorized") {
        DriverError::permission(first)
    } else {
        DriverError::invalid(first)
    }
}

impl Session {
    pub async fn open(link: &HostLink, params: &ConnectParams) -> Result<Self> {
        if let Some(name) = params
            .options
            .keys()
            .find(|name| !crate::SETTINGS.contains(&name.as_str()))
        {
            return Err(DriverError::invalid(format!(
                "Hive has no setting {name}: use {}",
                crate::SETTINGS.join(", ")
            )));
        }
        let secure = params.tls.mode != TlsMode::Disable;
        let host = params.host.as_deref().unwrap_or("localhost");
        let nodes = http::nodes(
            host,
            params.port.or(Some(DEFAULT_PORT)),
            secure,
            DEFAULT_PORT,
        );
        let tls = tls::client_config(&params.tls)?;
        let path = params
            .options
            .get("httpPath")
            .map(|path| format!("/{}", path.trim().trim_start_matches('/')))
            .unwrap_or_else(|| DEFAULT_PATH.into());
        let user = params.user.clone().filter(|user| !user.is_empty());
        let authorization = user.as_ref().map(|user| {
            let pair = format!("{user}:{}", params.password.clone().unwrap_or_default());
            format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD.encode(pair)
            )
        });
        let database = params.database.clone().filter(|name| !name.is_empty());
        let session = Self {
            http: http::Client::new(link, &params.connection, nodes, tls)?,
            path,
            authorization,
            cookie: Mutex::new(None),
            handle: Mutex::new(None),
            sequence: AtomicI32::new(0),
            database,
        };
        let mut configuration = Vec::new();
        if let Some(database) = &session.database {
            configuration.push((Thrift::text("use:database"), Thrift::text(database)));
        }
        let request = Builder::new()
            .set(1, Thrift::I32(PROTOCOL))
            .some(2, user.as_deref().map(Thrift::text))
            .some(3, params.password.as_deref().map(Thrift::text))
            .set(4, Thrift::Map(11, 11, configuration))
            .build();
        let answer = session.call("OpenSession", request).await?;
        check(&answer)?;
        let handle = answer
            .field(3)
            .cloned()
            .ok_or_else(|| DriverError::network("HiveServer2 opened no session"))?;
        *session.handle.lock().unwrap() = Some(handle);
        Ok(session)
    }

    /// The session handle, for the requests that name it (field 1 of most of them).
    pub fn handle(&self) -> Result<Thrift> {
        self.handle
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| DriverError::closed("The session of HiveServer2 is closed"))
    }

    /// A call of `TCLIService` and its result.
    pub async fn call(&self, name: &str, request: Thrift) -> Result<Thrift> {
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let mut headers = vec![
            ("content-type", "application/x-thrift".to_owned()),
            ("accept", "application/x-thrift".to_owned()),
        ];
        // The cookie HiveServer2 gave stands for the credentials from then on.
        match self.cookie.lock().unwrap().clone() {
            Some(cookie) => headers.push(("cookie", cookie)),
            None => {
                if let Some(authorization) = &self.authorization {
                    headers.push(("authorization", authorization.clone()));
                }
            }
        }
        let call = Call {
            method: "POST",
            path: &self.path,
            headers,
            body: Some(thrift::call(name, sequence, request)),
        };
        let answer = self.http.send(&call).await?;
        if answer.status == 401 || answer.status == 403 {
            // An expired cookie: the credentials once more.
            if self.cookie.lock().unwrap().take().is_some() {
                return Box::pin(self.call_again(name, call.body.unwrap_or_default())).await;
            }
            return Err(DriverError::auth(
                "HiveServer2 refused the user or the password",
            ));
        }
        if answer.status >= 400 {
            return Err(DriverError::network(format!(
                "HiveServer2 answered HTTP {}: check the port and the HTTP path ({})",
                answer.status, self.path
            )));
        }
        self.keep_cookie(&answer.headers);
        thrift::reply(&answer.body, name)
    }

    async fn call_again(&self, name: &str, body: Vec<u8>) -> Result<Thrift> {
        let mut headers = vec![
            ("content-type", "application/x-thrift".to_owned()),
            ("accept", "application/x-thrift".to_owned()),
        ];
        if let Some(authorization) = &self.authorization {
            headers.push(("authorization", authorization.clone()));
        }
        let call = Call {
            method: "POST",
            path: &self.path,
            headers,
            body: Some(body),
        };
        let answer = self.http.send(&call).await?;
        if answer.status == 401 || answer.status == 403 {
            return Err(DriverError::auth(
                "HiveServer2 refused the user or the password",
            ));
        }
        self.keep_cookie(&answer.headers);
        thrift::reply(&answer.body, name)
    }

    fn keep_cookie(&self, headers: &[(String, String)]) {
        let cookie = headers
            .iter()
            .filter(|(name, _)| name.eq_ignore_ascii_case("set-cookie"))
            .filter_map(|(_, value)| value.split(';').next())
            .find(|pair| pair.starts_with("hive.server2.auth="))
            .map(str::to_owned);
        if let Some(cookie) = cookie {
            *self.cookie.lock().unwrap() = Some(cookie);
        }
    }

    /// Closes the session on the server; nothing is left to close afterwards.
    pub async fn close(&self) {
        let handle = self.handle.lock().unwrap().take();
        if let Some(handle) = handle {
            let request = Builder::new().set(1, handle).build();
            let _ = self.call("CloseSession", request).await;
        }
    }

    /// How long to wait before asking again whether an operation finished: a little longer
    /// each time, up to a second.
    pub fn backoff(attempt: u32) -> Duration {
        Duration::from_millis((50 * 2u64.pow(attempt.min(5))).min(1000))
    }
}
