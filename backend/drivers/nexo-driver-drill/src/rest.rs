//! The REST API of a Drillbit: a form login whose session cookie goes with every request,
//! `POST /query.json` for SQL, `/storage.json` for the plugins and `/profiles` to find and
//! cancel a running query.
use nexo_driver_sdk::{
    DriverError, HostLink, Result,
    http::{self, Call},
    protocol::{ConnectParams, TlsMode, TlsSettings},
    tls,
};
use serde_json::{Value as Json, json};
use std::sync::Mutex;

pub(crate) struct Drill {
    http: http::Client,
    /// `j_username` and `j_password`, to log in again when the session expires.
    login: Option<(String, String)>,
    cookie: Mutex<Option<String>>,
    /// The schema a statement starts in.
    pub schema: Option<String>,
}

/// The form a Drillbit logs in with, its values escaped.
pub(crate) fn form(user: &str, password: &str) -> String {
    let escape = |text: &str| {
        text.bytes()
            .map(|byte| match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    (byte as char).to_string()
                }
                other => format!("%{other:02X}"),
            })
            .collect::<String>()
    };
    format!(
        "j_username={}&j_password={}",
        escape(user),
        escape(password)
    )
}

/// The error a Drillbit answered with.
pub(crate) fn failure(status: u16, body: &[u8]) -> DriverError {
    let parsed: Json = serde_json::from_slice(body).unwrap_or_default();
    let message = parsed["errorMessage"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| String::from_utf8_lossy(body).chars().take(500).collect());
    classify(status, &message)
}

/// How often, and how far apart, the profile of a failed query is asked for its error.
const PROFILE_TRIES: u32 = 10;
const PROFILE_WAIT: std::time::Duration = std::time::Duration::from_millis(200);

/// The error a query profile keeps, if it has one yet.
fn profile_message(profile: &Json) -> Option<String> {
    [&profile["error"], &profile["verboseError"]]
        .into_iter()
        .filter_map(Json::as_str)
        .find(|error| !error.trim().is_empty())
        .map(str::to_owned)
}

/// An error by its HTTP status and the first line of Drill's message.
fn classify(status: u16, message: &str) -> DriverError {
    let first = message.lines().next().unwrap_or_default().to_owned();
    match status {
        401 => DriverError::auth(first),
        403 => DriverError::permission(first),
        _ if first.contains("PARSE ERROR") || first.contains("VALIDATION ERROR") => {
            DriverError::syntax(first)
        }
        _ => DriverError::invalid(first),
    }
}

impl Drill {
    pub async fn open(link: &HostLink, params: &ConnectParams) -> Result<Self> {
        let secure = params.tls.mode != TlsMode::Disable;
        let nodes = http::nodes(
            params.host.as_deref().unwrap_or("localhost"),
            params.port,
            secure,
            8047,
        );
        let tls = match tls::client_config(&params.tls)? {
            Some(config) => Some(config),
            None if nodes.iter().any(|node| node.tls) => tls::client_config(&TlsSettings {
                mode: TlsMode::Verify,
                ..params.tls.clone()
            })?,
            None => None,
        };
        let user = params.user.clone().filter(|user| !user.is_empty());
        let login = user.map(|user| (user, params.password.clone().unwrap_or_default()));
        let drill = Self {
            http: http::Client::new(link, &params.connection, nodes, tls)?,
            login,
            cookie: Mutex::new(None),
            schema: params.database.clone().filter(|schema| !schema.is_empty()),
        };
        drill.log_in().await?;
        Ok(drill)
    }

    /// Logs in with the form, keeping the session's cookie; nothing without a user.
    async fn log_in(&self) -> Result<()> {
        let Some((user, password)) = &self.login else {
            return Ok(());
        };
        let call = Call {
            method: "POST",
            path: "/j_security_check",
            headers: vec![("content-type", "application/x-www-form-urlencoded".into())],
            body: Some(form(user, password).into_bytes()),
        };
        let answer = self.http.send(&call).await?;
        let cookie = answer
            .headers
            .iter()
            .filter(|(name, _)| name.eq_ignore_ascii_case("set-cookie"))
            .filter_map(|(_, value)| value.split(';').next())
            .find(|pair| pair.starts_with("JSESSIONID="))
            .map(str::to_owned);
        // A wrong password sends the browser back to the login page.
        let refused = answer
            .header("location")
            .is_some_and(|to| to.contains("login"));
        match cookie {
            Some(cookie) if !refused => {
                *self.cookie.lock().unwrap() = Some(cookie);
                Ok(())
            }
            _ => Err(DriverError::auth("Drill refused the user or the password")),
        }
    }

    /// A request with the session; logged in again once when the session expired.
    pub async fn send(&self, method: &str, path: &str, body: Option<&Json>) -> Result<Json> {
        for attempt in 0..2 {
            let mut headers = vec![("accept", "application/json".to_owned())];
            if let Some(cookie) = self.cookie.lock().unwrap().clone() {
                headers.push(("cookie", cookie));
            }
            if body.is_some() {
                headers.push(("content-type", "application/json".into()));
            }
            let call = Call {
                method,
                path,
                headers,
                body: body.map(|body| body.to_string().into_bytes()),
            };
            let answer = self.http.send(&call).await?;
            let expired = answer.status == 401
                || answer
                    .header("location")
                    .is_some_and(|to| to.contains("login"));
            if expired && attempt == 0 && self.login.is_some() {
                self.log_in().await?;
                continue;
            }
            if answer.status >= 400 {
                return Err(failure(answer.status, &answer.body));
            }
            return answer.json();
        }
        Err(DriverError::auth("The session of Drill expired"))
    }

    /// Runs a statement, at most `limit` rows.
    pub async fn query(&self, sql: &str, limit: Option<u64>) -> Result<Json> {
        let mut body = json!({"queryType": "SQL", "query": sql});
        if let Some(limit) = limit {
            body["autoLimit"] = json!(limit);
        }
        if let Some(schema) = &self.schema {
            body["defaultSchema"] = json!(schema);
        }
        if let Some((user, _)) = &self.login {
            body["userName"] = json!(user);
        }
        let answer = self.send("POST", "/query.json", Some(&body)).await?;
        match answer["queryState"].as_str() {
            Some(state) if state != "COMPLETED" => Err(self.why(&answer, state).await),
            _ => Ok(answer),
        }
    }

    /// Why a query did not complete: the message of the answer or, since Drill 1.21 answers
    /// only the state, the error its profile keeps.
    async fn why(&self, answer: &Json, state: &str) -> DriverError {
        let written = answer["errorMessage"].as_str().map(str::to_owned);
        // An id of Drill (hexadecimal and dashes) is the only thing that goes in the path.
        let id = answer["queryId"]
            .as_str()
            .filter(|id| id.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
        let message = match (written, id) {
            (Some(message), _) => Some(message),
            // Only a failed query has an error to wait for; a cancelled one is looked at once.
            (None, Some(id)) => {
                let tries = if state == "FAILED" { PROFILE_TRIES } else { 1 };
                self.profile_error(id, tries).await
            }
            (None, None) => None,
        };
        match message.filter(|message| !message.trim().is_empty()) {
            Some(message) => classify(200, &message),
            None => DriverError::invalid(format!("Drill says the query is {state}")),
        }
    }

    /// The error the profile of a query keeps. Drill writes the profile after it answers
    /// the query, so a profile not there yet, or without its error yet, is asked again.
    async fn profile_error(&self, id: &str, tries: u32) -> Option<String> {
        for attempt in 0..tries {
            if attempt > 0 {
                tokio::time::sleep(PROFILE_WAIT).await;
            }
            let Ok(profile) = self
                .send("GET", &format!("/profiles/{id}.json"), None)
                .await
            else {
                continue;
            };
            if let Some(error) = profile_message(&profile) {
                return Some(error);
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_login_form_and_errors_are_written_as_drill_reads_them() {
        assert_eq!(
            form("ana", "p&s=w ord"),
            "j_username=ana&j_password=p%26s%3Dw%20ord"
        );
        let error = failure(
            500,
            br#"{"errorMessage": "PARSE ERROR: Encountered \"FORM\"\n\nmore"}"#,
        );
        assert_eq!(error.message, "PARSE ERROR: Encountered \"FORM\"");
        assert_eq!(error.code, nexo_driver_sdk::ErrorCode::Syntax);
        assert_eq!(failure(401, b"no").code, nexo_driver_sdk::ErrorCode::Auth);
    }

    #[test]
    fn a_profile_gives_its_error_only_once_it_has_one() {
        assert_eq!(profile_message(&json!({"query": "SELEC"})), None);
        assert_eq!(profile_message(&json!({"error": "  "})), None);
        assert_eq!(
            profile_message(&json!({"error": "PARSE ERROR: x", "verboseError": "long"})),
            Some("PARSE ERROR: x".to_owned())
        );
        assert_eq!(
            profile_message(&json!({"error": "", "verboseError": "VALIDATION ERROR: y"})),
            Some("VALIDATION ERROR: y".to_owned())
        );
    }
}
