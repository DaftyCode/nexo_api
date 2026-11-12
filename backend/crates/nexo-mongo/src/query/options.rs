//! Query options from the payload: Extended JSON, page size, collation and hint.
use super::*;

/// A document in canonical Extended JSON, so every BSON type survives the trip.
pub fn extended_json(raw: &RawDocument) -> Result<Value> {
    let document = Document::try_from(raw)
        .map_err(|error| Error::Validation(format!("A document could not be read: {error}")))?;
    Ok(Bson::Document(document).into_canonical_extjson())
}

/// A document in canonical Extended JSON.
pub fn extended_json_document(document: Document) -> Result<Value> {
    Ok(Bson::Document(document).into_canonical_extjson())
}

pub(super) fn page_size(page: u64) -> Result<u64> {
    if (1..=limits::PAGE_DOCUMENTS).contains(&page) {
        Ok(page)
    } else {
        Err(Error::Validation(format!(
            "A page has between 1 and {} documents",
            limits::PAGE_DOCUMENTS
        )))
    }
}

/// An Extended JSON object (canonical or relaxed) as a BSON document.
pub fn document(value: Option<Value>, what: &str) -> Result<Option<Document>> {
    let Some(value) = value else {
        return Ok(None);
    };
    match Bson::try_from(value) {
        Ok(Bson::Document(document)) => Ok(Some(document)),
        Ok(_) => Err(Error::Validation(format!("The {what} must be a document"))),
        Err(error) => Err(Error::Validation(format!(
            "Invalid Extended JSON in the {what}: {error}"
        ))),
    }
}

pub(super) fn collation(value: Option<Value>) -> Result<Option<Collation>> {
    let Some(document) = document(value, "collation")? else {
        return Ok(None);
    };
    bson::deserialize_from_document(document)
        .map(Some)
        .map_err(|error| Error::Validation(format!("Invalid collation: {error}")))
}

/// An index name, or the keys of an index.
pub(super) fn hint(value: Option<Value>) -> Result<Option<Hint>> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(name)) if name.trim().is_empty() => Ok(None),
        Some(Value::String(name)) => Ok(Some(Hint::Name(name))),
        Some(keys @ Value::Object(_)) => Ok(document(Some(keys), "hint")?.map(Hint::Keys)),
        Some(_) => Err(Error::Validation(
            "The hint is an index name or its keys".into(),
        )),
    }
}
