//! The requests of a run in order, with the scripts, variables and authorization each one
//! inherits from its folders.
use super::*;

pub(super) fn rows(map: &Map<String, Value>) -> Vec<Value> {
    map.iter()
        .map(|(key, value)| json!({"key": key, "value": value, "enabled": true}))
        .collect()
}

/// Enabled `{key, value}` rows as a map; later rows win.
pub fn values(rows: &Value) -> Map<String, Value> {
    let mut map = Map::new();
    for row in rows.as_array().into_iter().flatten() {
        if row["enabled"] == false || row["disabled"] == true {
            continue;
        }
        if let Some(key) = row["key"].as_str().filter(|k| !k.is_empty()) {
            map.insert(
                key.to_string(),
                row.get("value").cloned().unwrap_or(json!("")),
            );
        }
    }
    map
}

/// Secrets a session resolves and redacts: vault secrets as `vault:<name>`, and OAuth 2.0
/// token variables (`$oauth2.<name>.access_token`) added by the engine.
pub(super) fn session_secrets(payload: &Value) -> Map<String, Value> {
    let mut secrets: Map<String, Value> = payload["resolvedSecrets"]
        .as_object()
        .map(|map| {
            map.iter()
                .map(|(k, v)| (format!("vault:{k}"), v.clone()))
                .collect()
        })
        .unwrap_or_default();
    if let Some(variables) = payload["resolvedOAuth2"].as_object() {
        secrets.extend(variables.clone());
    }
    secrets
}
pub(super) struct Step {
    pub(super) item: Value,
    pub(super) parents: Vec<Value>,
}
impl Step {
    /// The request to send, with the authorization of the nearest folder or collection
    /// when it inherits one.
    pub(super) fn request(&self) -> Value {
        let mut request = match &self.item["request"] {
            Value::String(url) => json!({"method": "GET", "url": url}),
            Value::Object(_) => self.item["request"].clone(),
            _ => json!({}),
        };
        if request.get("auth").is_none_or(Value::is_null)
            && let Some(auth) = self
                .parents
                .iter()
                .rev()
                .find_map(|group| group.get("auth").filter(|a| a.is_object()))
        {
            request["auth"] = auth.clone();
        }
        request
    }
    /// Variables of the folders around the request and of the request itself, nearest last.
    pub(super) fn layered_variables(&self) -> Map<String, Value> {
        let mut layered = Map::new();
        for group in self.parents.iter().skip(1) {
            layered.extend(values(&group["variable"]));
        }
        layered.extend(values(&self.item["variable"]));
        layered
    }
}

/// The first request of a payload and its authorization: its own or the inherited one,
/// before its variables are replaced.
pub(super) fn authorized_step(payload: &Value) -> Result<(Value, Step)> {
    let collection = as_collection(payload)?;
    let mut steps = Vec::new();
    flatten(&collection, &[], &mut steps);
    let step = steps
        .into_iter()
        .next()
        .ok_or_else(|| Error::Validation("Nothing to authorize".into()))?;
    if !step.request()["auth"].is_object() {
        return Err(Error::Validation(
            "No authorization is set for this request".into(),
        ));
    }
    Ok((collection, step))
}
/// The authorization a request would be sent with, before its variables are replaced.
pub fn request_auth(payload: &Value) -> Result<Value> {
    Ok(authorized_step(payload)?.1.request()["auth"].clone())
}
/// The authorization a request would be sent with: the request's own or the inherited one,
/// with `{{variables}}` and vault secrets replaced exactly as when it is sent.
pub fn resolved_auth(payload: &Value) -> Result<Map<String, Value>> {
    let (collection, step) = authorized_step(payload)?;
    let auth = step.request()["auth"].clone();
    let mut collection_variables = values(&collection["variable"]);
    collection_variables.extend(step.layered_variables());
    let secrets = session_secrets(payload);
    let seed = json!({
        "environment": values(&payload["variables"]),
        "globals": values(&payload["globals"]),
        "local": {},
        "collection": collection_variables,
        "data": {},
        "secrets": secrets,
        "request": {"auth": auth},
        "iteration": 0,
        "iterationCount": 1,
        "requestName": step.item["name"],
        "requestId": step.item["id"],
        "uuid": uuid::Uuid::new_v4().to_string(),
    });
    let session = ScriptSession::new(&seed, Arc::new(AtomicBool::new(false)))?;
    Ok(crate::auth::values(&session.replace(&auth)?))
}
pub(super) fn flatten(group: &Value, parents: &[Value], output: &mut Vec<Step>) {
    let mut chain = parents.to_vec();
    chain.push(group.clone());
    for item in group["item"].as_array().into_iter().flatten() {
        if item["item"].is_array() {
            flatten(item, &chain, output);
        } else {
            output.push(Step {
                item: item.clone(),
                parents: chain.clone(),
            });
        }
    }
}
pub(super) fn scripts(groups: &[&Value], listen: &str) -> Vec<String> {
    groups
        .iter()
        .flat_map(|group| group["event"].as_array().into_iter().flatten())
        .filter(|event| event["listen"] == listen)
        .map(|event| match &event["script"]["exec"] {
            Value::Array(lines) => lines
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("\n"),
            Value::String(text) => text.clone(),
            _ => String::new(),
        })
        .filter(|source| !source.trim().is_empty())
        .collect()
}
