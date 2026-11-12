//! MongoDB payloads of the schema explorer: the schema of a sample, and the validation rules
//! it can become.
use super::*;

payload! {
    /// `mongo.schema`: the schema of `size` documents picked at random (`$sample`, 1 000 when
    /// absent, 10 000 at most), of the whole collection or of those that match `filter`, with
    /// the JSON Schema and the MongoDB validator it gives. `id` cancels it with `mongo.cancel`.
    closed MongoSchemaPayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            id "id": String => "string",
            database "database": String => "string",
            collection "collection": String => "string",
        }
        optional {
            workspace "workspace": String => "string",
            size "size": u64 => "number",
            filter "filter": Map<String, Value> => "object",
        }
    }
}

payload! {
    /// `mongo.collection.validator`: replaces the validation rules of a collection
    /// (`collMod`); an empty `validator` removes them. `confirm` repeats the collection's
    /// name. `validationLevel` (`strict` when absent) says which writes are checked and
    /// `validationAction` (`error` when absent) whether a bad one is refused or only logged.
    closed MongoCollectionValidatorPayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            connection_id "connectionId": String => "string",
            database "database": String => "string",
            collection "collection": String => "string",
            validator "validator": Map<String, Value> => "object",
            confirm "confirm": String => "string",
        }
        optional {
            workspace "workspace": String => "string",
            validation_level "validationLevel": ValidationLevel => "'off' | 'strict' | 'moderate'",
            validation_action "validationAction": ValidationAction => "'error' | 'warn'",
        }
    }
}

payload! {
    /// `mongo.shell`: a command of the MongoDB shell (`db.orders.find({…})`, `use shop`,
    /// `show collections`) on a saved `connection` (its identifier), starting in `database`.
    /// `confirm` is the name typed to confirm a destructive command; `variables` fill the
    /// connection's URI.
    closed MongoShellPayload {
        required {
            connection "connection": String => "string",
            database "database": String => "string",
            command "command": String => "string",
        }
        optional {
            workspace "workspace": String => "string",
            confirm "confirm": String => "string",
            variables "variables": Map<String, Value> => "Record<string, string>",
        }
    }
}

/// Which writes a validator checks: none, every one, or those of documents already valid.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ValidationLevel {
    Off,
    #[default]
    Strict,
    Moderate,
}

/// What happens to a write a validator refuses: it fails, or it is only logged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ValidationAction {
    #[default]
    Error,
    Warn,
}
