//! Explains: how the server runs a `find` or an aggregation, with `queryPlanner` (planned
//! only) or `executionStats` (run and measured, as the query would run; nothing is written).
//! The answer goes back in relaxed Extended JSON, so its counts and times are plain numbers.
use crate::{
    MongoAdapter,
    browse::check_name,
    errors, limits,
    query::{comment, document, guarded},
};
use bson::{Bson, Document, doc};
use mongodb::Client;
use nexo_application::ports::{ExplainRequest, Explained};
use nexo_domain::{Error, Result};
use serde_json::Value;

/// Aggregation stages that write: an explain that runs the pipeline could write with them.
const WRITING_STAGES: [&str; 2] = ["$out", "$merge"];

pub async fn explain(
    adapter: &MongoAdapter,
    client: Client,
    request: ExplainRequest,
) -> Result<Value> {
    check_name(&request.database, "database")?;
    check_name(&request.collection, "collection")?;
    let comment = comment(&request.id);
    let mut explained = command(&request.collection, request.explained)?;
    explained.insert("maxTimeMS", limits::OPERATION.as_millis() as i64);
    explained.insert("comment", comment.as_str());
    let verbosity = if request.execution_stats {
        "executionStats"
    } else {
        "queryPlanner"
    };
    let command = doc! {"explain": explained, "verbosity": verbosity};
    let database = client.database(&request.database);
    let mut answer = guarded(adapter, &request.id, &client, &comment, async {
        database.run_command(command).await.map_err(errors::driver)
    })
    .await?;
    // Signatures of the cluster's clock, not part of the plan.
    answer.remove("$clusterTime");
    answer.remove("operationTime");
    Ok(Bson::Document(answer).into_relaxed_extjson())
}

/// The command explained: a `find` with the fields of a query, or an `aggregate`.
fn command(collection: &str, explained: Explained) -> Result<Document> {
    match explained {
        Explained::Find(find) => {
            let mut command = doc! {"find": collection};
            for (field, value) in [
                ("filter", find.filter),
                ("projection", find.projection),
                ("sort", find.sort),
                ("collation", find.collation),
            ] {
                if let Some(value) = document(value, field)? {
                    command.insert(field, value);
                }
            }
            if let Some(hint) = hint(find.hint)? {
                command.insert("hint", hint);
            }
            if let Some(skip) = find.skip.filter(|skip| *skip > 0) {
                command.insert("skip", i64::try_from(skip).unwrap_or(i64::MAX));
            }
            if let Some(limit) = find.limit {
                command.insert("limit", i64::try_from(limit).unwrap_or(i64::MAX));
            }
            Ok(command)
        }
        Explained::Aggregate {
            pipeline,
            collation,
            hint: wanted,
        } => {
            let mut stages = Vec::with_capacity(pipeline.len());
            for stage in pipeline {
                let stage = document(Some(stage), "pipeline stage")?
                    .ok_or_else(|| Error::Validation("A pipeline stage is a document".into()))?;
                if let Some(writing) = stage
                    .keys()
                    .find(|key| WRITING_STAGES.contains(&key.as_str()))
                {
                    return Err(Error::Validation(format!(
                        "A pipeline with {writing} is not explained: running it to measure it would write"
                    )));
                }
                stages.push(Bson::Document(stage));
            }
            let mut command = doc! {"aggregate": collection, "pipeline": stages, "cursor": {}};
            if let Some(collation) = document(collation, "collation")? {
                command.insert("collation", collation);
            }
            if let Some(hint) = hint(wanted)? {
                command.insert("hint", hint);
            }
            Ok(command)
        }
    }
}

/// An index name, or the keys of an index.
fn hint(value: Option<Value>) -> Result<Option<Bson>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(name)) if name.trim().is_empty() => Ok(None),
        Some(Value::String(name)) => Ok(Some(Bson::String(name))),
        Some(keys @ Value::Object(_)) => Ok(document(Some(keys), "hint")?.map(Bson::Document)),
        Some(_) => Err(Error::Validation(
            "The hint is an index name or its keys".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nexo_application::ports::FindRequest;
    use serde_json::json;

    #[test]
    fn explains_a_find_with_the_fields_of_the_query() {
        let command = command(
            "orders",
            Explained::Find(Box::new(FindRequest {
                filter: Some(json!({"at": {"$gte": {"$date": "2024-01-02T00:00:00Z"}}})),
                sort: Some(json!({"at": -1})),
                hint: Some(json!("at_-1")),
                skip: Some(0),
                limit: Some(10),
                ..Default::default()
            })),
        )
        .unwrap();
        assert_eq!(command.get_str("find").unwrap(), "orders");
        assert!(matches!(
            command
                .get_document("filter")
                .unwrap()
                .get_document("at")
                .unwrap()
                .get("$gte"),
            Some(Bson::DateTime(_))
        ));
        assert_eq!(command.get_str("hint").unwrap(), "at_-1");
        assert_eq!(command.get_i64("limit").unwrap(), 10);
        assert!(!command.contains_key("skip"), "a skip of 0 is not sent");
    }

    #[test]
    fn explains_pipelines_that_do_not_write() {
        let command = command(
            "orders",
            Explained::Aggregate {
                pipeline: vec![
                    json!({"$match": {"a": 1}}),
                    json!({"$group": {"_id": "$b"}}),
                ],
                collation: Some(json!({"locale": "es"})),
                hint: Some(json!({"a": 1})),
            },
        )
        .unwrap();
        assert_eq!(command.get_array("pipeline").unwrap().len(), 2);
        assert_eq!(command.get_document("hint").unwrap(), &doc! {"a": 1});
        for writing in ["$out", "$merge"] {
            let error = super::command(
                "orders",
                Explained::Aggregate {
                    pipeline: vec![json!({ writing: "copy" })],
                    collation: None,
                    hint: None,
                },
            )
            .unwrap_err();
            assert!(error.to_string().contains("would write"), "{error}");
        }
        assert!(
            super::command(
                "orders",
                Explained::Aggregate {
                    pipeline: vec![json!(["$match"])],
                    collation: None,
                    hint: None,
                },
            )
            .is_err()
        );
    }
}
