//! `nx.mongo` in scripts: each call becomes the `mongo.*` operation the interface would send,
//! on the saved connection the script names, so it passes the same checks. The script never
//! receives the connection's URI, password or certificates.
use crate::{
    Application,
    operations::Operation,
    ports::{ScriptCall, ScriptDatabase},
};
use async_trait::async_trait;
use nexo_domain::{DocumentKind, Error, Result, WorkspaceId};
use serde_json::{Map, Value, json};

mod admin;

/// Documents a script reads at most with `find` or `aggregate`.
pub const SCRIPT_DOCUMENTS: u64 = 1_000;

/// Replaces `{{ name }}` with the script variable of that name; others are left as written.
fn fill(text: &str, variables: &Map<String, Value>) -> String {
    let mut output = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        let Some(length) = rest[start + 2..].find("}}") else {
            break;
        };
        let name = rest[start + 2..start + 2 + length].trim();
        output.push_str(&rest[..start]);
        match variables.get(name) {
            Some(Value::String(value)) => output.push_str(value),
            Some(value) if !value.is_null() => output.push_str(&value.to_string()),
            _ => output.push_str(&rest[start..start + 4 + length]),
        }
        rest = &rest[start + 4 + length..];
    }
    output.push_str(rest);
    output
}

/// A saved connection as the operations receive it: variables filled where the interface
/// fills them, vault references left for the application to resolve.
pub(crate) fn connection(value: &Value, variables: &Map<String, Value>) -> Value {
    let mut connection = Map::new();
    for (key, filled) in [
        ("uri", true),
        ("password", false),
        ("caPem", true),
        ("certPem", true),
        ("keyPem", false),
    ] {
        if let Some(text) = value.get(key).and_then(Value::as_str) {
            if text.trim().is_empty() {
                continue;
            }
            let text = if filled {
                fill(text, variables)
            } else {
                text.to_string()
            };
            connection.insert(key.into(), Value::String(text));
        }
    }
    Value::Object(connection)
}

fn document(value: Option<&Value>, what: &str) -> Result<Map<String, Value>> {
    match value {
        None | Some(Value::Null) => Ok(Map::new()),
        Some(Value::Object(fields)) => Ok(fields.clone()),
        Some(_) => Err(Error::Validation(format!("The {what} must be a document"))),
    }
}

/// A count option (`skip`, `limit`) of a script, as a plain number.
fn count(options: &Map<String, Value>, key: &str) -> Result<Option<u64>> {
    match options.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .map(Some)
            .ok_or_else(|| Error::Validation(format!("{key} is a whole number"))),
    }
}

#[async_trait]
impl ScriptDatabase for Application {
    async fn script_call(&self, call: ScriptCall) -> Result<Value> {
        let workspace = WorkspaceId::parse(&call.workspace)?;
        let saved = self
            .workspaces
            .documents(&workspace, Some(DocumentKind::Connection))
            .await?
            .into_iter()
            .find(|document| {
                document.id.as_str() == call.connection || document.name == call.connection
            })
            .ok_or_else(|| {
                Error::Validation(format!(
                    "No saved MongoDB connection is named {}",
                    call.connection
                ))
            })?;
        let mut base = Map::new();
        base.insert("workspace".into(), json!(call.workspace));
        base.insert(
            "connection".into(),
            connection(&saved.value, &call.variables),
        );
        base.insert("database".into(), json!(call.database));
        base.insert("collection".into(), json!(call.collection));
        let id = || json!(format!("script-{}", uuid::Uuid::new_v4()));
        let with = |fields: Value| {
            let mut payload = base.clone();
            payload.extend(fields.as_object().cloned().unwrap_or_default());
            Value::Object(payload)
        };
        let write = |fields: Value| {
            let mut payload = with(fields);
            payload["connectionId"] = json!(saved.id.as_str());
            payload
        };
        let argument = |index: usize| call.arguments.get(index);
        let filter = || document(argument(0), "filter");
        let options = |index: usize| document(argument(index), "options");
        match call.method.as_str() {
            "find" | "findOne" => {
                let options = options(1)?;
                let one = call.method == "findOne";
                let limit = if one {
                    1
                } else {
                    count(&options, "limit")?
                        .filter(|limit| *limit > 0)
                        .unwrap_or(SCRIPT_DOCUMENTS)
                        .min(SCRIPT_DOCUMENTS)
                };
                let mut fields =
                    json!({"filter": filter()?, "id": id(), "limit": limit, "pageSize": limit});
                for key in ["projection", "sort"] {
                    if let Some(value) = options.get(key) {
                        fields[key] = value.clone();
                    }
                }
                if let Some(skip) = count(&options, "skip")? {
                    fields["skip"] = json!(skip);
                }
                let page = self.execute(Operation::MongoFind, with(fields)).await?;
                let documents = self.page(page).await?;
                Ok(if one {
                    documents.into_iter().next().unwrap_or(Value::Null)
                } else {
                    Value::Array(documents)
                })
            }
            "countDocuments" | "estimatedDocumentCount" => {
                let answer = self
                    .execute(
                        Operation::MongoCount,
                        with(json!({"filter": filter()?, "id": id()})),
                    )
                    .await?;
                Ok(answer["count"].clone())
            }
            "aggregate" => {
                let pipeline = match argument(0) {
                    Some(Value::Array(stages)) => stages.clone(),
                    _ => {
                        return Err(Error::Validation(
                            "The pipeline is an array of stages".into(),
                        ));
                    }
                };
                let mut fields =
                    json!({"pipeline": pipeline, "id": id(), "pageSize": SCRIPT_DOCUMENTS});
                for (key, value) in options(1)? {
                    if ["allowDiskUse", "collation", "hint", "maxTimeMS"].contains(&key.as_str()) {
                        fields[key] = value;
                    }
                }
                let page = self
                    .execute(Operation::MongoAggregate, with(fields))
                    .await?;
                Ok(Value::Array(self.page(page).await?))
            }
            "insertOne" | "insertMany" => {
                let documents = match (call.method.as_str(), argument(0)) {
                    ("insertOne", Some(document @ Value::Object(_))) => vec![document.clone()],
                    ("insertMany", Some(Value::Array(documents))) => documents.clone(),
                    _ => {
                        return Err(Error::Validation(
                            "insertOne takes a document, insertMany an array of documents".into(),
                        ));
                    }
                };
                let answer = self
                    .execute(
                        Operation::MongoInsert,
                        write(json!({"documents": documents})),
                    )
                    .await?;
                let ids = answer["inserted"].as_array().cloned().unwrap_or_default();
                Ok(if call.method == "insertOne" {
                    json!({"acknowledged": true, "insertedId": ids.first().cloned().unwrap_or(Value::Null)})
                } else {
                    json!({"acknowledged": true, "insertedCount": ids.len(), "insertedIds": ids})
                })
            }
            "updateOne" | "updateMany" | "replaceOne" => {
                let filter = filter()?;
                let (operation, fields) = if call.method == "replaceOne" {
                    let replacement = document(argument(1), "replacement")?;
                    (
                        Operation::MongoReplace,
                        json!({"filter": filter, "replacement": replacement}),
                    )
                } else {
                    let update = argument(1).cloned().unwrap_or(Value::Null);
                    let many = call.method == "updateMany";
                    let mut fields = json!({"filter": filter, "update": update, "many": many});
                    if many {
                        fields["expected"] =
                            self.matching(&with(json!({})), &fields["filter"]).await?;
                    }
                    (Operation::MongoUpdate, fields)
                };
                let answer = self.execute(operation, write(fields)).await?;
                Ok(
                    json!({"acknowledged": true, "matchedCount": answer["matched"], "modifiedCount": answer["modified"]}),
                )
            }
            "deleteOne" | "deleteMany" => {
                let many = call.method == "deleteMany";
                let mut fields = json!({"filter": filter()?, "many": many});
                if many {
                    fields["expected"] = self.matching(&with(json!({})), &fields["filter"]).await?;
                    // Emptying the collection needs its name, as in the interface.
                    if let Some(confirm) = options(1)?
                        .get("confirm")
                        .cloned()
                        .or(call.confirm.clone().map(Value::String))
                    {
                        fields["confirm"] = confirm;
                    }
                }
                let answer = self.execute(Operation::MongoDelete, write(fields)).await?;
                Ok(json!({"acknowledged": true, "deletedCount": answer["deleted"]}))
            }
            _ => {
                let connection = base["connection"].clone();
                self.script_admin(&call, connection, saved.id.as_str())
                    .await
            }
        }
    }
}

impl Application {
    /// The documents of a first page; an open cursor is closed, as scripts read one page.
    async fn page(&self, page: Value) -> Result<Vec<Value>> {
        if let Some(cursor) = page["cursor"].as_str() {
            let _ = self
                .execute(Operation::MongoClose, json!({"cursor": cursor}))
                .await;
        }
        Ok(page["documents"].as_array().cloned().unwrap_or_default())
    }
    /// How many documents a filter matches now: what a write to many documents expects.
    async fn matching(&self, base: &Value, filter: &Value) -> Result<Value> {
        let mut payload = base.clone();
        payload["filter"] = filter.clone();
        payload["id"] = json!(format!("script-{}", uuid::Uuid::new_v4()));
        Ok(self.execute(Operation::MongoCount, payload).await?["count"].clone())
    }
}
