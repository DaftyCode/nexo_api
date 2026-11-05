//! Netrc, as Insomnia sends it (through curl's `CURLOPT_NETRC`): the login and password of the
//! `machine` entry for the request's host, or of the `default` entry when no machine matches,
//! go as `Authorization: Basic …`. Without a match nothing is sent.
//!
//! Only the user's own file is read: `~/.netrc`, and on Windows also `~/_netrc` (the home is
//! `HOME`, else `USERPROFILE`), as curl does. `NEXO_NETRC` names another file for tests; a
//! collection can never choose the path.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use nexo_domain::Result;
use serde_json::{Map, Value};

use super::Outgoing;

/// A larger file is not a netrc file.
const MAX_SIZE: u64 = 1024 * 1024;

#[derive(Debug, Default, PartialEq)]
struct Entry {
    /// `None` for the `default` entry.
    machine: Option<String>,
    login: String,
    password: String,
}

/// Splits netrc text into tokens as curl does: whitespace separates them, `"…"` quotes one
/// (with `\` escapes), `#` comments out the rest of the line, and `macdef` skips its macro up
/// to the next blank line.
fn tokens(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(&c) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
            continue;
        }
        if c == '#' {
            for c in chars.by_ref() {
                if c == '\n' {
                    break;
                }
            }
            continue;
        }
        let mut token = String::new();
        if c == '"' {
            chars.next();
            while let Some(c) = chars.next() {
                match c {
                    '"' => break,
                    '\\' => match chars.next() {
                        Some('n') => token.push('\n'),
                        Some('r') => token.push('\r'),
                        Some('t') => token.push('\t'),
                        Some(other) => token.push(other),
                        None => {}
                    },
                    other => token.push(other),
                }
            }
        } else {
            while let Some(&c) = chars.peek() {
                if c.is_whitespace() {
                    break;
                }
                token.push(c);
                chars.next();
            }
        }
        if token == "macdef" {
            // The macro body ends at the first empty line.
            let mut previous_newline = false;
            for c in chars.by_ref() {
                if c == '\n' {
                    if previous_newline {
                        break;
                    }
                    previous_newline = true;
                } else if c != '\r' {
                    previous_newline = false;
                }
            }
            continue;
        }
        tokens.push(token);
    }
    tokens
}

fn entries(text: &str) -> Vec<Entry> {
    let mut entries: Vec<Entry> = Vec::new();
    let mut tokens = tokens(text).into_iter();
    while let Some(token) = tokens.next() {
        match token.as_str() {
            "machine" => entries.push(Entry {
                machine: Some(tokens.next().unwrap_or_default()),
                ..Entry::default()
            }),
            "default" => entries.push(Entry::default()),
            "login" | "password" | "account" => {
                let value = tokens.next().unwrap_or_default();
                if let Some(entry) = entries.last_mut() {
                    match token.as_str() {
                        "login" => entry.login = value,
                        "password" => entry.password = value,
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    entries
}

/// The entry for a host: its `machine` (case-insensitive), else `default`.
fn find<'a>(entries: &'a [Entry], host: &str) -> Option<&'a Entry> {
    entries
        .iter()
        .find(|entry| {
            entry
                .machine
                .as_deref()
                .is_some_and(|machine| machine.eq_ignore_ascii_case(host))
        })
        .or_else(|| entries.iter().find(|entry| entry.machine.is_none()))
}

fn read(path: &std::path::Path) -> Option<String> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_SIZE {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// The user's netrc file, as curl finds it.
fn user_netrc() -> Option<String> {
    if let Some(path) = std::env::var_os("NEXO_NETRC") {
        return read(std::path::Path::new(&path));
    }
    let home = std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .or_else(|| std::env::var_os("USERPROFILE"))?;
    let names: &[&str] = if cfg!(windows) {
        &[".netrc", "_netrc"]
    } else {
        &[".netrc"]
    };
    names
        .iter()
        .find_map(|name| read(&std::path::Path::new(&home).join(name)))
}

fn sign_with(netrc: Option<String>, request: &mut Outgoing) {
    let Some(text) = netrc else { return };
    let host = request
        .url
        .host_str()
        .unwrap_or("")
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    let entries = entries(&text);
    let Some(entry) = find(&entries, &host) else {
        return;
    };
    let credentials = STANDARD.encode(format!("{}:{}", entry.login, entry.password));
    request
        .headers
        .set("Authorization", &format!("Basic {credentials}"));
    request.credential_headers.push("Authorization".into());
}

pub fn sign(_auth: &Map<String, Value>, request: &mut Outgoing) -> Result<()> {
    sign_with(user_netrc(), request);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::HeaderList;

    const NETRC: &str = r#"
# Work machines
machine api.example.com login ada password "pa ss\"word"
machine OTHER.example.com
  login grace
  account ignored
  password hopper
macdef init
cd /pub
machine fake.example.com login not password used

default login anonymous password guest
"#;

    fn authorization(netrc: Option<&str>, url: &str) -> Vec<String> {
        let mut url = url::Url::parse(url).unwrap();
        let mut headers = HeaderList::default();
        sign_with(
            netrc.map(str::to_string),
            &mut Outgoing {
                method: "GET",
                url: &mut url,
                headers: &mut headers,
                body: &mut Vec::new(),
                credential_headers: &mut Vec::new(),
            },
        );
        headers
            .get("authorization")
            .into_iter()
            .map(str::to_string)
            .collect()
    }

    fn basic(credentials: &str) -> Vec<String> {
        vec![format!("Basic {}", STANDARD.encode(credentials))]
    }

    #[test]
    fn reads_machines_quotes_comments_and_macros_like_curl() {
        assert_eq!(
            authorization(Some(NETRC), "https://api.example.com/x"),
            basic("ada:pa ss\"word")
        );
        assert_eq!(
            authorization(Some(NETRC), "https://other.EXAMPLE.com"),
            basic("grace:hopper")
        );
        // The macro hides the machine written inside it; the host gets the default entry.
        assert_eq!(
            authorization(Some(NETRC), "https://fake.example.com"),
            basic("anonymous:guest")
        );
    }

    #[test]
    fn falls_back_to_default_and_sends_nothing_without_a_match() {
        assert_eq!(
            authorization(Some(NETRC), "https://unknown.example.com"),
            basic("anonymous:guest")
        );
        let without_default = "machine api.example.com login ada password secret";
        assert!(authorization(Some(without_default), "https://unknown.example.com").is_empty());
        assert!(authorization(None, "https://api.example.com").is_empty());
        assert_eq!(
            entries("machine a login only"),
            vec![Entry {
                machine: Some("a".into()),
                login: "only".into(),
                password: String::new()
            }]
        );
    }
}
