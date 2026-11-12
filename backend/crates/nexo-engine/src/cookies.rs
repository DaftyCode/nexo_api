//! Cookie jars per workspace, kept on disk between sessions, and the cookie manager that
//! lists, adds, edits and deletes their cookies.
//!
//! Like Postman and Insomnia, a jar keeps session cookies (without `Expires` or `Max-Age`)
//! too: they last until the person deletes them, not until Nexo closes.
use crate::{transport::CookieJar, vault::write_atomic};
use aws_lc_rs::digest;
use cookie_store::{Cookie, CookieDomain, CookieStore};
use nexo_domain::{Error, Result};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use url::{Host, Url};

/// What a browser keeps for one cookie: its name and value together.
const MAX_COOKIE: usize = 4096;

/// Cookie jars per workspace, kept on disk between sessions.
pub struct Jars {
    directory: PathBuf,
    jars: Mutex<HashMap<String, CookieJar>>,
}
impl Jars {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            jars: Mutex::new(HashMap::new()),
        }
    }
    fn path(&self, scope: &str) -> PathBuf {
        self.directory.join(format!(
            "{}.json",
            crate::hex::encode(digest::digest(&digest::SHA256, scope.as_bytes()))
        ))
    }
    /// The jar of a workspace, loaded from disk the first time. Expired cookies stay behind.
    pub fn get(&self, scope: &str) -> CookieJar {
        let mut jars = self.jars.lock().unwrap_or_else(|e| e.into_inner());
        jars.entry(scope.to_string())
            .or_insert_with(|| {
                let store = std::fs::File::open(self.path(scope))
                    .ok()
                    .and_then(|file| {
                        cookie_store::serde::json::load(std::io::BufReader::new(file)).ok()
                    })
                    .unwrap_or_default();
                Arc::new(Mutex::new(store))
            })
            .clone()
    }
    /// Writes the jar, session cookies included; the expired ones are dropped when it loads.
    pub fn save(&self, scope: &str) {
        let jar = self.get(scope);
        let mut buffer = Vec::new();
        let saved = {
            let store = jar.lock().unwrap_or_else(|e| e.into_inner());
            cookie_store::serde::json::save_incl_expired_and_nonpersistent(&store, &mut buffer)
                .is_ok()
        };
        if saved && std::fs::create_dir_all(&self.directory).is_ok() {
            let _ = write_atomic(&self.path(scope), &buffer);
        }
    }
    /// The cookies that have not expired, by domain, path and name.
    pub fn list(&self, scope: &str) -> Vec<Value> {
        let jar = self.get(scope);
        let store = jar.lock().unwrap_or_else(|e| e.into_inner());
        let mut cookies: Vec<&Cookie<'static>> = store.iter_unexpired().collect();
        cookies.sort_by_key(|cookie| {
            (
                String::from(&cookie.domain),
                String::from(&cookie.path),
                cookie.name().to_string(),
            )
        });
        cookies.into_iter().map(view).collect()
    }
    /// Adds a cookie, or replaces the one named by `original` when it is edited. The next
    /// request to a matching address sends it.
    pub fn set(&self, scope: &str, input: &Value) -> Result<Value> {
        let (cookie, url) = parse(input, now())?;
        let shown = view(&cookie);
        let jar = self.get(scope);
        {
            let mut store = jar.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(original) = input.get("original").filter(|v| v.is_object()) {
                store.remove(
                    original["domain"].as_str().unwrap_or(""),
                    original["path"].as_str().unwrap_or(""),
                    original["name"].as_str().unwrap_or(""),
                );
            }
            store
                .insert(cookie, &url)
                .map_err(|error| Error::Validation(format!("The cookie is not valid: {error}")))?;
        }
        self.save(scope);
        Ok(shown)
    }
    /// Deletes one cookie by its domain, path and name.
    pub fn delete(&self, scope: &str, domain: &str, path: &str, name: &str) -> bool {
        let jar = self.get(scope);
        let deleted = jar
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(domain, path, name)
            .is_some();
        if deleted {
            self.save(scope);
        }
        deleted
    }
    pub fn clear(&self, scope: &str) {
        let jar = self.get(scope);
        *jar.lock().unwrap_or_else(|e| e.into_inner()) = CookieStore::default();
        let _ = std::fs::remove_file(self.path(scope));
    }
}

/// A cookie as the manager shows it. `domain` and `path` identify it with its name.
fn view(cookie: &Cookie<'_>) -> Value {
    let expires = match &cookie.expires {
        cookie_store::CookieExpiration::AtUtc(at) => {
            json!(at.unix_timestamp() * 1000 + i64::from(at.millisecond()))
        }
        cookie_store::CookieExpiration::SessionEnd => Value::Null,
    };
    json!({
        "name": cookie.name(),
        "value": cookie.value(),
        "domain": String::from(&cookie.domain),
        "hostOnly": matches!(cookie.domain, CookieDomain::HostOnly(_)),
        "path": String::from(&cookie.path),
        "expires": expires,
        "secure": cookie.secure().unwrap_or(false),
        "httpOnly": cookie.http_only().unwrap_or(false),
        "sameSite": cookie.same_site().map(|s| s.to_string()),
    })
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The domain a cookie is for: a host name or an IP address, without scheme, port or path.
fn host(domain: &str) -> Result<Url> {
    let domain = domain.trim();
    let domain = domain.strip_prefix('.').unwrap_or(domain);
    let invalid = || Error::Validation(format!("'{domain}' is not a domain"));
    if domain.is_empty() {
        return Err(Error::Validation("The cookie needs a domain".into()));
    }
    if domain
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || "/\\@?#".contains(c))
    {
        return Err(invalid());
    }
    let url = Url::parse(&format!("https://{domain}/")).map_err(|_| invalid())?;
    if url.port().is_some() || url.host().is_none() {
        return Err(invalid());
    }
    Ok(url)
}

/// Checks a cookie of the manager and builds it as a `Set-Cookie` from its domain would.
fn parse(input: &Value, now: u64) -> Result<(Cookie<'static>, Url)> {
    let text = |key: &str| input[key].as_str().unwrap_or("");
    let flag = |key: &str| input[key].as_bool().unwrap_or(false);
    let name = text("name").trim();
    if name.is_empty() {
        return Err(Error::Validation("The cookie needs a name".into()));
    }
    // A token of RFC 6265: visible characters, without separators.
    if let Some(c) = name
        .chars()
        .find(|c| !c.is_ascii_graphic() || "()<>@,;:\\\"/[]?={}".contains(*c))
    {
        return Err(Error::Validation(format!(
            "The cookie name cannot contain '{}'",
            c.escape_default()
        )));
    }
    let value = text("value").trim();
    if let Some(c) = value.chars().find(|c| c.is_control() || *c == ';') {
        return Err(Error::Validation(format!(
            "The cookie value cannot contain '{}'",
            c.escape_default()
        )));
    }
    if name.len() + value.len() > MAX_COOKIE {
        return Err(Error::Validation(format!(
            "A cookie can have up to {MAX_COOKIE} bytes of name and value"
        )));
    }
    let url = host(text("domain"))?;
    let path = match text("path").trim() {
        "" => "/",
        path => path,
    };
    if !path.starts_with('/')
        || path
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || c == ';')
    {
        return Err(Error::Validation(
            "The cookie path starts with / and has no spaces or ';'".into(),
        ));
    }
    let mut header = format!("{name}={value}; Path={path}");
    let host = url.host_str().unwrap_or_default();
    if flag("includeSubdomains") {
        if !matches!(url.host(), Some(Host::Domain(_))) {
            return Err(Error::Validation(
                "Only a domain name has subdomains, not an IP address".into(),
            ));
        }
        header.push_str(&format!("; Domain={host}"));
    }
    if let Some(expires) = input["expires"].as_u64() {
        if expires <= now {
            return Err(Error::Validation(
                "The expiry date has already passed".into(),
            ));
        }
        header.push_str(&format!("; Max-Age={}", (expires - now).div_ceil(1000)));
    }
    if flag("secure") {
        header.push_str("; Secure");
    }
    if flag("httpOnly") {
        header.push_str("; HttpOnly");
    }
    match text("sameSite").to_ascii_lowercase().as_str() {
        "" => {}
        "strict" => header.push_str("; SameSite=Strict"),
        "lax" => header.push_str("; SameSite=Lax"),
        "none" => header.push_str("; SameSite=None"),
        other => {
            return Err(Error::Validation(format!(
                "SameSite is Strict, Lax or None, not '{other}'"
            )));
        }
    }
    let cookie = Cookie::parse(header, &url)
        .map_err(|error| Error::Validation(format!("The cookie is not valid: {error}")))?
        .into_owned();
    Ok((cookie, url))
}

#[cfg(test)]
mod tests;
