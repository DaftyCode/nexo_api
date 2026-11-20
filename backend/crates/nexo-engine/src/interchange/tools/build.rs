//! Requests, folders and collections in Nexo's (Postman's) format, as every importer
//! builds them.
use super::{Report, Row};
use crate::collection::{SCHEMA, encode_query_part};
use serde_json::{Map, Value, json};

/// A script of another tool, commented out behind a line that says why.
fn commented(tool: &str, scripts: &[&str]) -> Option<Value> {
    let parts: Vec<&str> = scripts
        .iter()
        .copied()
        .filter(|script| !script.trim().is_empty())
        .collect();
    if parts.is_empty() {
        return None;
    }
    let mut lines = vec![format!(
        "// Imported from {tool}, whose scripts use another API: translate it to pm.* and uncomment it."
    )];
    for part in parts {
        lines.extend(part.lines().map(|line| format!("// {line}")));
    }
    Some(Value::from(lines))
}

/// Scripts of a request, folder or collection: generated lines that work as they are, and
/// the tool's own scripts commented out.
#[derive(Default)]
pub(crate) struct Scripts<'a> {
    pub generated: Vec<String>,
    pub before: Vec<&'a str>,
    pub after: Vec<&'a str>,
}

impl Scripts<'_> {
    /// Postman's `event` list, or nothing; a note when a script of the tool was left out.
    fn events(&self, tool: &str, item: &str, report: &mut Report) -> Option<Value> {
        let mut events = Vec::new();
        let mut before: Vec<Value> = self.generated.iter().map(|line| json!(line)).collect();
        if let Some(Value::Array(lines)) = commented(tool, &self.before) {
            report.note("script", item);
            before.extend(lines);
        }
        if !before.is_empty() {
            events.push(json!({"listen": "prerequest", "script": {"type": "text/javascript", "exec": before}}));
        }
        if let Some(lines) = commented(tool, &self.after) {
            report.note("script", item);
            events.push(
                json!({"listen": "test", "script": {"type": "text/javascript", "exec": lines}}),
            );
        }
        (!events.is_empty()).then(|| Value::Array(events))
    }
}

/// Lines that set request variables before it is sent, as Postman's `pm.variables.set`.
pub(crate) fn set_variables(rows: &[Row]) -> Vec<String> {
    rows.iter()
        .filter(|row| row.enabled && !row.key.is_empty())
        .map(|row| {
            format!(
                "pm.variables.set({}, {});",
                json!(row.key),
                json!(row.value)
            )
        })
        .collect()
}

/// A request of another tool, ready to become a collection item.
#[derive(Default)]
pub(crate) struct Request<'a> {
    pub name: String,
    pub method: String,
    pub url: String,
    pub query: Vec<Row>,
    pub path: Vec<Row>,
    pub headers: Vec<Row>,
    pub body: Value,
    /// `None` inherits the authorization of the folder or collection.
    pub auth: Option<Value>,
    pub description: String,
    pub scripts: Scripts<'a>,
}

impl Request<'_> {
    /// The collection item. Enabled query parameters go into the URL unless it already has
    /// a query string (the tools that keep both keep them alike); disabled ones are kept
    /// apart, as Nexo stores them.
    pub fn item(self, tool: &str, report: &mut Report) -> Value {
        report.requests += 1;
        let mut url = self.url.trim().to_string();
        if !url.contains('?') {
            let query: Vec<String> = self
                .query
                .iter()
                .filter(|row| row.enabled && !row.key.is_empty())
                .map(|row| {
                    format!(
                        "{}={}",
                        encode_query_part(&row.key),
                        encode_query_part(&row.value)
                    )
                })
                .collect();
            if !query.is_empty() {
                url = format!("{url}?{}", query.join("&"));
            }
        }
        let headers: Vec<Value> = self
            .headers
            .iter()
            .filter(|row| !row.key.is_empty())
            .map(|row| json!({"key": row.key, "value": row.value, "disabled": !row.enabled}))
            .collect();
        let variables: Vec<Value> = self
            .path
            .iter()
            .map(|row| json!({"key": row.key, "value": row.value}))
            .collect();
        let method = if self.method.trim().is_empty() {
            "GET".to_string()
        } else {
            self.method.trim().to_uppercase()
        };
        let mut request = json!({
            "method": method,
            "header": headers,
            "url": {"raw": url, "variable": variables},
        });
        if !self.body.is_null() {
            request["body"] = self.body;
        }
        if let Some(auth) = self.auth {
            request["auth"] = auth;
        }
        if !self.description.trim().is_empty() {
            request["description"] = json!(self.description);
        }
        let mut item = json!({"name": self.name, "request": request});
        let disabled: Vec<Value> = self
            .query
            .iter()
            .filter(|row| !row.enabled && !row.key.is_empty())
            .map(|row| json!({"key": row.key, "value": row.value}))
            .collect();
        if !disabled.is_empty() {
            item["nexoDisabledQuery"] = Value::Array(disabled);
        }
        if let Some(events) = self.scripts.events(tool, &self.name, report) {
            item["event"] = events;
        }
        item
    }
}

/// A folder or a collection root: its items with what they inherit.
#[derive(Default)]
pub(crate) struct Group<'a> {
    pub name: String,
    pub items: Vec<Value>,
    pub auth: Option<Value>,
    pub variables: Vec<Row>,
    pub description: String,
    pub scripts: Scripts<'a>,
}

impl Group<'_> {
    fn fill(self, tool: &str, target: &mut Map<String, Value>, report: &mut Report) {
        if let Some(auth) = self.auth {
            target.insert("auth".into(), auth);
        }
        let variables: Vec<Value> = self
            .variables
            .iter()
            .filter(|row| !row.key.is_empty())
            .map(|row| {
                let mut stored = json!({"key": row.key, "value": row.value});
                if !row.enabled {
                    stored["disabled"] = json!(true);
                }
                if row.secret {
                    stored["type"] = json!("secret");
                }
                stored
            })
            .collect();
        if !variables.is_empty() {
            target.insert("variable".into(), Value::Array(variables));
        }
        if let Some(events) = self.scripts.events(tool, &self.name, report) {
            target.insert("event".into(), events);
        }
        target.insert("item".into(), Value::Array(self.items));
    }

    pub fn folder(self, tool: &str, report: &mut Report) -> Value {
        report.folders += 1;
        let mut folder = Map::new();
        folder.insert("name".into(), json!(self.name));
        if !self.description.trim().is_empty() {
            folder.insert("description".into(), json!(self.description));
        }
        self.fill(tool, &mut folder, report);
        Value::Object(folder)
    }

    pub fn collection(self, tool: &str, report: &mut Report) -> Value {
        let mut info = json!({"name": self.name, "schema": SCHEMA});
        if !self.description.trim().is_empty() {
            info["description"] = json!(self.description);
        }
        let mut collection = Map::new();
        collection.insert("info".into(), info);
        self.fill(tool, &mut collection, report);
        Value::Object(collection)
    }
}
