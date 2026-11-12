//! The schema of a report as JSON Schema (draft 2020-12) or as a MongoDB validator
//! (`{$jsonSchema: …}`, with `bsonType`). A field present in every document is required;
//! documents describe their fields and arrays their items. No other rule is invented.
use super::{FieldSchema, SchemaReport};
use serde_json::{Map, Value, json};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchemaDialect {
    /// JSON Schema draft 2020-12, with `type`.
    JsonSchema,
    /// A MongoDB validator: `{$jsonSchema: …}` with `bsonType`.
    MongoValidator,
}

/// The type a JSON Schema gives a value of this type, if it can say.
fn json_type(name: &str) -> Option<&'static str> {
    Some(match name {
        "Int32" | "Int64" | "Integer" => "integer",
        "Double" | "Decimal128" | "Number" => "number",
        "String" | "ObjectId" | "Date" | "Binary" | "UUID" | "Symbol" | "Code" => "string",
        "Boolean" => "boolean",
        "Null" | "Undefined" => "null",
        "Document" | "Object" => "object",
        "Array" => "array",
        _ => return None,
    })
}

/// The `bsonType` of a MongoDB validator for this type.
fn bson_type(name: &str) -> &'static str {
    match name {
        "ObjectId" => "objectId",
        "Int32" => "int",
        "Int64" | "Integer" => "long",
        "Double" | "Number" => "double",
        "Decimal128" => "decimal",
        "Boolean" => "bool",
        "Date" => "date",
        "Null" => "null",
        "Document" | "Object" => "object",
        "Array" => "array",
        "Binary" | "UUID" => "binData",
        "RegExp" => "regex",
        "Timestamp" => "timestamp",
        "MinKey" => "minKey",
        "MaxKey" => "maxKey",
        "Code" => "javascript",
        "Symbol" => "symbol",
        "DBPointer" => "dbPointer",
        "Undefined" => "undefined",
        _ => "string",
    }
}

/// The schema of the documents a report describes.
pub fn json_schema(report: &SchemaReport, dialect: SchemaDialect) -> Value {
    let mut children: HashMap<&str, Vec<&FieldSchema>> = HashMap::new();
    for field in &report.fields {
        children.entry(parent(field)).or_default().push(field);
    }
    let writer = Writer { children, dialect };
    let mut root = Map::new();
    match dialect {
        SchemaDialect::JsonSchema => {
            root.insert(
                "$schema".into(),
                json!("https://json-schema.org/draft/2020-12/schema"),
            );
            root.insert("type".into(), json!("object"));
        }
        SchemaDialect::MongoValidator => {
            root.insert("bsonType".into(), json!("object"));
        }
    }
    writer.fields("", &mut root);
    match dialect {
        SchemaDialect::JsonSchema => Value::Object(root),
        SchemaDialect::MongoValidator => json!({ "$jsonSchema": root }),
    }
}

/// The path of the document or array a field belongs to; `""` at the top.
fn parent(field: &FieldSchema) -> &str {
    if field.depth == 0 {
        return "";
    }
    &field.path[..field.path.len() - field.name.len() - 1]
}

struct Writer<'a> {
    children: HashMap<&'a str, Vec<&'a FieldSchema>>,
    dialect: SchemaDialect,
}

impl Writer<'_> {
    /// `properties` and `required` of the document at `path`.
    fn fields(&self, path: &str, schema: &mut Map<String, Value>) {
        let fields: Vec<&FieldSchema> = self
            .children
            .get(path)
            .map(|fields| fields.iter().filter(|f| f.name != "[]").copied().collect())
            .unwrap_or_default();
        if fields.is_empty() {
            return;
        }
        let required: Vec<&str> = fields
            .iter()
            .filter(|field| field.count == field.parents)
            .map(|field| field.name.as_str())
            .collect();
        if !required.is_empty() {
            schema.insert("required".into(), json!(required));
        }
        let properties: Map<String, Value> = fields
            .iter()
            .map(|field| (field.name.clone(), self.field(field)))
            .collect();
        schema.insert("properties".into(), Value::Object(properties));
    }

    fn field(&self, field: &FieldSchema) -> Value {
        let mut schema = Map::new();
        let names = field.types.iter().map(|summary| summary.name.as_str());
        match self.dialect {
            SchemaDialect::JsonSchema => {
                let mut types: Vec<&str> = Vec::new();
                let mut every = true;
                for name in names {
                    match json_type(name) {
                        Some(json) if !types.contains(&json) => types.push(json),
                        Some(_) => {}
                        None => every = false,
                    }
                }
                if types.contains(&"number") {
                    types.retain(|name| *name != "integer");
                }
                // A type JSON cannot name (a timestamp, a regular expression…) allows any.
                if every && !types.is_empty() {
                    schema.insert("type".into(), one_or_many(types));
                }
            }
            SchemaDialect::MongoValidator => {
                let mut types: Vec<&str> = Vec::new();
                for name in names.map(bson_type) {
                    if !types.contains(&name) {
                        types.push(name);
                    }
                }
                schema.insert("bsonType".into(), one_or_many(types));
            }
        }
        let has = |names: &[&str]| field.types.iter().any(|t| names.contains(&t.name.as_str()));
        if has(&["Document", "Object"]) {
            self.fields(&field.path, &mut schema);
        }
        if has(&["Array"]) {
            let items = self
                .children
                .get(field.path.as_str())
                .and_then(|fields| fields.iter().find(|f| f.name == "[]"));
            if let Some(items) = items {
                schema.insert("items".into(), self.field(items));
            }
        }
        Value::Object(schema)
    }
}

fn one_or_many(names: Vec<&str>) -> Value {
    if names.len() == 1 {
        json!(names[0])
    } else {
        json!(names)
    }
}
