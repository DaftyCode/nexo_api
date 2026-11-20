//! `schema.infer`: the JSON Schema of the responses of a request, read from their bodies with
//! the analysis of the MongoDB schema explorer (`nexo_domain::schema`).
use nexo_domain::{
    Error, Result,
    schema::{SchemaOptions, infer},
};
use serde_json::{Value, json};

/// Responses a schema is read from, at most.
pub const MAX_SAMPLES: usize = 100;

pub fn infer_schema(payload: &Value) -> Result<Value> {
    let samples = payload["samples"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    if samples.is_empty() || samples.len() > MAX_SAMPLES {
        return Err(Error::Validation(format!(
            "A schema is read from 1 to {MAX_SAMPLES} JSON responses"
        )));
    }
    let options = SchemaOptions {
        enums: payload["enums"] == json!(true),
    };
    Ok(json!({"schema": infer(samples, options), "sampled": samples.len()}))
}
