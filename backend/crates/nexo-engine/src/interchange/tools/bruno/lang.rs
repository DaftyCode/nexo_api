//! Bruno's `.bru` files read as the JSON Bruno itself builds from them (`bruToJson`,
//! `envToJson` of `bruno-lang` v2, checked on 2026-11-20). A file is made of blocks that
//! start at the first column (`name {` or `name [`) and end with `}` or `]` there:
//! dictionaries of `key: value` pairs (`~` turns one off), text blocks (bodies, scripts,
//! tests, docs) indented by two spaces, and lists.
use serde_json::{Map, Value, json};

pub(super) enum Block {
    Text(String),
    Pairs(Vec<Pair>),
    List(Vec<String>),
}

pub(super) struct Pair {
    pub key: String,
    pub value: Value,
    pub enabled: bool,
}

fn is_text(name: &str) -> bool {
    matches!(name, "body" | "tests" | "docs")
        || name.starts_with("script:")
        || (name.starts_with("body:")
            && !matches!(
                name,
                "body:form-urlencoded"
                    | "body:multipart-form"
                    | "body:file"
                    | "body:grpc"
                    | "body:ws"
            ))
}

/// The blocks of a file, in order.
pub(super) fn blocks(text: &str) -> Vec<(String, Block)> {
    let lines: Vec<&str> = text.lines().collect();
    let mut blocks = Vec::new();
    let mut at = 0;
    while at < lines.len() {
        let line = lines[at].trim_end();
        at += 1;
        let (name, close) = match (line.strip_suffix('{'), line.strip_suffix('[')) {
            (Some(name), _) if !line.starts_with([' ', '\t']) => (name.trim(), "}"),
            (_, Some(name)) if !line.starts_with([' ', '\t']) => (name.trim(), "]"),
            _ => continue,
        };
        let start = at;
        while at < lines.len() && lines[at].trim_end() != close {
            at += 1;
        }
        let inner = &lines[start..at.min(lines.len())];
        at += 1;
        let block = if close == "]" {
            Block::List(items(inner))
        } else if is_text(name) {
            Block::Text(outdent(inner, 2))
        } else {
            Block::Pairs(pairs(inner))
        };
        blocks.push((name.to_string(), block));
    }
    blocks
}

/// Lines without the indentation of the block, without the empty lines that open it.
fn outdent(lines: &[&str], spaces: usize) -> String {
    let lines: Vec<&str> = lines
        .iter()
        .skip_while(|line| line.trim().is_empty())
        .map(|line| {
            let indent = line.len() - line.trim_start_matches(' ').len();
            &line[indent.min(spaces)..]
        })
        .collect();
    lines.join("\n")
}

fn items(lines: &[&str]) -> Vec<String> {
    lines
        .iter()
        .map(|line| line.trim().trim_end_matches(',').trim().to_string())
        .filter(|line| !line.is_empty())
        .collect()
}

/// Whether a line is an annotation (`@description('…')`) of the pair below, not a pair
/// whose name starts with `@` (`@token: $res.body.token`).
fn is_annotation(line: &str) -> bool {
    line.starts_with('@')
        && match (line.find(':'), line.find('(')) {
            (None, _) => true,
            (Some(colon), Some(paren)) => paren < colon,
            (Some(_), None) => false,
        }
}

/// A key, quoted (`"key: with colons"`, with `\"` inside) or plain, and what follows it.
fn key(line: &str) -> Option<(String, &str)> {
    if let Some(quoted) = line.strip_prefix('"') {
        let mut key = String::new();
        let mut chars = quoted.char_indices();
        while let Some((at, c)) = chars.next() {
            match c {
                '\\' => {
                    if let Some((_, next)) = chars.next() {
                        key.push(next);
                    }
                }
                '"' => return Some((key, quoted[at + 1..].trim_start().strip_prefix(':')?)),
                other => key.push(other),
            }
        }
        return None;
    }
    let colon = line.find(':')?;
    Some((line[..colon].trim().to_string(), &line[colon + 1..]))
}

fn pairs(lines: &[&str]) -> Vec<Pair> {
    let mut pairs = Vec::new();
    let mut at = 0;
    while at < lines.len() {
        let line = lines[at].trim();
        at += 1;
        if line.is_empty() {
            continue;
        }
        if is_annotation(line) {
            // An annotation whose argument spans lines ends where `''')` closes it.
            if line.contains("('''") && !line.ends_with("''')") {
                while at < lines.len() && !lines[at].trim_end().ends_with("''')") {
                    at += 1;
                }
                at += 1;
            }
            continue;
        }
        let (enabled, line) = match line.strip_prefix('~') {
            Some(rest) => (false, rest),
            None => (true, line),
        };
        let Some((key, rest)) = key(line) else {
            continue;
        };
        let rest = rest.trim();
        let value = if rest.starts_with("'''") && rest.trim_end_matches("'''").trim().is_empty() {
            let start = at;
            while at < lines.len() && !lines[at].trim_start().starts_with("'''") {
                at += 1;
            }
            let text = multiline(&lines[start..at.min(lines.len())]);
            at += 1;
            json!(text)
        } else if rest == "[" {
            let start = at;
            while at < lines.len() && lines[at].trim() != "]" {
                at += 1;
            }
            let list = items(&lines[start..at.min(lines.len())]);
            at += 1;
            json!(list)
        } else {
            json!(rest)
        };
        pairs.push(Pair {
            key,
            value,
            enabled,
        });
    }
    pairs
}

/// The text of a `'''` value, without the indentation its lines share.
fn multiline(lines: &[&str]) -> String {
    let indent = lines
        .iter()
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.len() - line.trim_start().len())
        .min()
        .unwrap_or(0);
    lines
        .iter()
        .map(|line| line.get(indent..).unwrap_or("").trim_end())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The pairs of a dictionary as an object, for blocks of settings (`meta`, `auth:*`).
pub(super) fn object(pairs: &[Pair]) -> Map<String, Value> {
    pairs
        .iter()
        .map(|pair| (pair.key.clone(), pair.value.clone()))
        .collect()
}

/// The pairs of a dictionary as Bruno's rows, `{name, value, enabled}`.
pub(super) fn rows(pairs: &[Pair]) -> Vec<Value> {
    pairs
        .iter()
        .map(|pair| json!({"name": pair.key, "value": pair.value, "enabled": pair.enabled}))
        .collect()
}

/// An environment file: its variables, secret ones without their values (Bruno keeps those
/// on the computer, not in the file).
pub(super) fn environment(text: &str) -> Vec<Value> {
    let mut variables = Vec::new();
    for (name, block) in blocks(text) {
        match (name.as_str(), block) {
            ("vars", Block::Pairs(pairs)) => variables.extend(pairs.iter().map(|pair| {
                json!({"name": pair.key, "value": pair.value, "enabled": pair.enabled, "secret": false})
            })),
            ("vars:secret", Block::List(names)) => variables.extend(names.iter().map(|name| {
                let (enabled, name) = match name.strip_prefix('~') {
                    Some(name) => (false, name),
                    None => (true, name.as_str()),
                };
                json!({"name": name, "value": "", "enabled": enabled, "secret": true})
            })),
            _ => {}
        }
    }
    variables
}
