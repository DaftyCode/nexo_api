//! Indexes of a collection: listed with their size and how often queries use them, created,
//! hidden from the query planner or shown again, and dropped.
use crate::{
    browse::{check_name, number},
    errors,
    query::document,
};
use bson::{Bson, Document, doc};
use mongodb::Client;
use nexo_application::ports::{IndexChange, IndexDetail};
use nexo_domain::{Error, Result};
use std::collections::HashMap;

/// Options of `createIndexes` Nexo passes on; anything else is refused by name.
const INDEX_OPTIONS: [&str; 16] = [
    "name",
    "unique",
    "sparse",
    "hidden",
    "expireAfterSeconds",
    "partialFilterExpression",
    "collation",
    "weights",
    "default_language",
    "language_override",
    "textIndexVersion",
    "2dsphereIndexVersion",
    "bits",
    "min",
    "max",
    "wildcardProjection",
];

/// The index every collection has, which MongoDB never drops or hides.
const ID_INDEX: &str = "_id_";

pub async fn list(client: &Client, database: &str, collection: &str) -> Result<Vec<IndexDetail>> {
    check_name(database, "database")?;
    check_name(collection, "collection")?;
    let mut cursor = client
        .database(database)
        .run_cursor_command(doc! {"listIndexes": collection})
        .await
        .map_err(errors::driver)?;
    let mut specs = Vec::new();
    while cursor.advance().await.map_err(errors::driver)? {
        let spec: Document = cursor.deserialize_current().map_err(errors::driver)?;
        specs.push(spec);
    }
    // Sizes and use are extras: servers without `$collStats` or `$indexStats` (some compatible
    // ones, or a user without the privilege) still list their indexes.
    let sizes = sizes(client, database, collection)
        .await
        .unwrap_or_default();
    let usage = usage(client, database, collection)
        .await
        .unwrap_or_default();
    Ok(specs
        .into_iter()
        .map(|spec| {
            let name = spec.get_str("name").unwrap_or_default().to_string();
            let used = usage.get(&name);
            IndexDetail {
                size: sizes.get(&name).copied(),
                accesses: used.map(|(accesses, _)| *accesses),
                since: used.and_then(|(_, since)| since.clone()),
                spec: Bson::Document(spec).into_canonical_extjson(),
                name,
            }
        })
        .collect())
}

/// Bytes of each index, added up over the shards.
async fn sizes(client: &Client, database: &str, collection: &str) -> Result<HashMap<String, i64>> {
    let mut cursor = client
        .database(database)
        .collection::<Document>(collection)
        .aggregate(vec![doc! {"$collStats": {"storageStats": {}}}])
        .await
        .map_err(errors::driver)?;
    let mut sizes = HashMap::new();
    while cursor.advance().await.map_err(errors::driver)? {
        let part: Document = cursor.deserialize_current().map_err(errors::driver)?;
        let Ok(indexes) = part
            .get_document("storageStats")
            .and_then(|storage| storage.get_document("indexSizes"))
        else {
            continue;
        };
        for name in indexes.keys() {
            *sizes.entry(name.clone()).or_insert(0) += number(indexes, name).unwrap_or(0);
        }
    }
    Ok(sizes)
}

/// Operations that used each index since the server started counting, added up over the
/// servers, and the earliest of those starts.
async fn usage(
    client: &Client,
    database: &str,
    collection: &str,
) -> Result<HashMap<String, (i64, Option<String>)>> {
    let mut cursor = client
        .database(database)
        .collection::<Document>(collection)
        .aggregate(vec![doc! {"$indexStats": {}}])
        .await
        .map_err(errors::driver)?;
    let mut usage: HashMap<String, (i64, Option<bson::DateTime>)> = HashMap::new();
    while cursor.advance().await.map_err(errors::driver)? {
        let stats: Document = cursor.deserialize_current().map_err(errors::driver)?;
        let (Ok(name), Ok(accesses)) = (stats.get_str("name"), stats.get_document("accesses"))
        else {
            continue;
        };
        let entry = usage.entry(name.to_string()).or_insert((0, None));
        entry.0 += number(accesses, "ops").unwrap_or(0);
        if let Ok(since) = accesses.get_datetime("since") {
            entry.1 = Some(entry.1.map_or(*since, |known| known.min(*since)));
        }
    }
    Ok(usage
        .into_iter()
        .map(|(name, (accesses, since))| {
            let since = since.and_then(|since| since.try_to_rfc3339_string().ok());
            (name, (accesses, since))
        })
        .collect())
}

pub async fn change(client: &Client, change: IndexChange) -> Result<()> {
    match change {
        IndexChange::Create {
            database,
            collection,
            keys,
            options,
        } => {
            check_name(&database, "database")?;
            check_name(&collection, "collection")?;
            let keys = document(Some(keys), "index keys")?.unwrap_or_default();
            if keys.is_empty() {
                return Err(Error::Validation(
                    "Add at least one field to the index keys".into(),
                ));
            }
            let mut index = doc! {"key": keys.clone()};
            for (key, value) in document(options, "index options")?.unwrap_or_default() {
                if !INDEX_OPTIONS.contains(&key.as_str()) {
                    return Err(Error::Validation(format!("Unknown index option {key}")));
                }
                index.insert(key, value);
            }
            if index
                .get_str("name")
                .map_or(true, |name| name.trim().is_empty())
            {
                index.insert("name", default_name(&keys));
            }
            client
                .database(&database)
                .run_command(doc! {"createIndexes": &collection, "indexes": [index]})
                .await
                .map_err(errors::driver)?;
        }
        IndexChange::Hide {
            database,
            collection,
            name,
            hidden,
        } => {
            check_name(&database, "database")?;
            check_name(&collection, "collection")?;
            if name == ID_INDEX {
                return Err(Error::Validation("The _id index cannot be hidden".into()));
            }
            client
                .database(&database)
                .run_command(doc! {
                    "collMod": &collection,
                    "index": {"name": &name, "hidden": hidden},
                })
                .await
                .map_err(errors::driver)?;
        }
        IndexChange::Drop {
            database,
            collection,
            name,
        } => {
            check_name(&database, "database")?;
            check_name(&collection, "collection")?;
            if name == ID_INDEX {
                return Err(Error::Validation("The _id index cannot be dropped".into()));
            }
            // By name only: `*` would drop every index.
            if name.trim().is_empty() || name == "*" {
                return Err(Error::Validation("Name the index to drop".into()));
            }
            client
                .database(&database)
                .run_command(doc! {"dropIndexes": &collection, "index": &name})
                .await
                .map_err(errors::driver)?;
        }
    }
    Ok(())
}

/// The name MongoDB's drivers give an index without one: each field and its type, joined by
/// `_` (`status_1_at_-1`, `title_text`, `$**_1`).
fn default_name(keys: &Document) -> String {
    keys.iter()
        .map(|(field, kind)| {
            let kind = match kind {
                Bson::Int32(value) => value.to_string(),
                Bson::Int64(value) => value.to_string(),
                Bson::Double(value) if value.fract() == 0.0 => (*value as i64).to_string(),
                Bson::String(text) => text.clone(),
                other => other.to_string(),
            };
            format!("{field}_{kind}")
        })
        .collect::<Vec<_>>()
        .join("_")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_indexes_as_the_drivers_do() {
        assert_eq!(
            default_name(&doc! {"status": 1, "at": -1}),
            "status_1_at_-1"
        );
        assert_eq!(default_name(&doc! {"title": "text"}), "title_text");
        assert_eq!(default_name(&doc! {"$**": 1_i64}), "$**_1");
        assert_eq!(
            default_name(&doc! {"loc": "2dsphere", "n": 1.0}),
            "loc_2dsphere_n_1"
        );
    }
}
