//! The explorer's tree: databases, their collections, views and time series, and the size
//! and indexes of a collection.
use crate::errors;
use mongodb::{
    Client,
    bson::{Bson, Document, doc},
    error::ErrorKind,
};
use nexo_application::ports::{CollectionStats, CollectionSummary, DatabaseSummary, IndexSummary};
use nexo_domain::{Error, Result};
use std::collections::HashSet;

/// MongoDB's code for a command the user has no privilege to run.
const UNAUTHORIZED: i32 = 13;

/// The databases the user may read. A user who may not list them sees the database named in
/// the URI, as MongoDB Compass does.
pub async fn databases(
    client: &Client,
    default_database: Option<String>,
) -> Result<Vec<DatabaseSummary>> {
    let answer = client
        .database("admin")
        .run_command(doc! {"listDatabases": 1, "authorizedDatabases": true})
        .await;
    let answer = match answer {
        Ok(answer) => answer,
        Err(error)
            if matches!(error.kind.as_ref(), ErrorKind::Command(command) if command.code == UNAUTHORIZED)
                && default_database.is_some() =>
        {
            return Ok(default_database
                .into_iter()
                .map(|name| DatabaseSummary {
                    name,
                    size_on_disk: None,
                    empty: false,
                })
                .collect());
        }
        Err(error) => return Err(errors::driver(error)),
    };
    let mut databases: Vec<DatabaseSummary> = answer
        .get_array("databases")
        .map(|items| {
            items
                .iter()
                .filter_map(Bson::as_document)
                .filter_map(|database| {
                    Some(DatabaseSummary {
                        name: database.get_str("name").ok()?.to_string(),
                        size_on_disk: number(database, "sizeOnDisk"),
                        empty: database.get_bool("empty").unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    databases.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(databases)
}

/// The collections, views and time series collections of a database, with GridFS buckets
/// marked.
pub async fn collections(client: &Client, database: &str) -> Result<Vec<CollectionSummary>> {
    check_name(database, "database")?;
    let mut cursor = client
        .database(database)
        .run_cursor_command(
            doc! {"listCollections": 1, "authorizedCollections": true, "nameOnly": false},
        )
        .await
        .map_err(errors::driver)?;
    let mut collections = Vec::new();
    while cursor.advance().await.map_err(errors::driver)? {
        let specification: Document = cursor.deserialize_current().map_err(errors::driver)?;
        let Ok(name) = specification.get_str("name") else {
            continue;
        };
        let options = specification.get_document("options").ok();
        collections.push(CollectionSummary {
            name: name.to_string(),
            kind: specification
                .get_str("type")
                .unwrap_or("collection")
                .to_string(),
            gridfs: None,
            view_on: options
                .and_then(|options| options.get_str("viewOn").ok())
                .map(str::to_string),
            capped: options
                .and_then(|options| options.get_bool("capped").ok())
                .unwrap_or(false),
        });
    }
    mark_gridfs(&mut collections);
    collections.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(collections)
}

/// `<bucket>.files` and `<bucket>.chunks` together are a GridFS bucket.
fn mark_gridfs(collections: &mut [CollectionSummary]) {
    let names: HashSet<String> = collections.iter().map(|c| c.name.clone()).collect();
    for collection in collections.iter_mut() {
        let bucket = collection
            .name
            .strip_suffix(".files")
            .filter(|bucket| names.contains(&format!("{bucket}.chunks")))
            .or_else(|| {
                collection
                    .name
                    .strip_suffix(".chunks")
                    .filter(|bucket| names.contains(&format!("{bucket}.files")))
            });
        collection.gridfs = bucket.map(str::to_string);
    }
}

/// Size and indexes of a collection, added up over the shards of a sharded one.
pub async fn stats(client: &Client, database: &str, collection: &str) -> Result<CollectionStats> {
    check_name(database, "database")?;
    check_name(collection, "collection")?;
    let handle = client.database(database).collection::<Document>(collection);
    let mut parts = Vec::new();
    match handle
        .aggregate(vec![doc! {"$collStats": {"storageStats": {}}}])
        .await
    {
        Ok(mut cursor) => {
            while cursor.advance().await.map_err(errors::driver)? {
                let part: Document = cursor.deserialize_current().map_err(errors::driver)?;
                if let Ok(storage) = part.get_document("storageStats") {
                    parts.push(storage.clone());
                }
            }
        }
        // Servers without `$collStats` (some compatible ones) still answer `collStats`.
        Err(_) => parts.push(
            client
                .database(database)
                .run_command(doc! {"collStats": collection})
                .await
                .map_err(errors::driver)?,
        ),
    }
    let total = |field: &str| parts.iter().filter_map(|part| number(part, field)).sum();
    let count: i64 = total("count");
    let size: i64 = total("size");
    let indexes = indexes(client, database, collection).await?;
    Ok(CollectionStats {
        count,
        size,
        storage_size: total("storageSize"),
        average_document_size: (count > 0).then(|| size / count),
        total_index_size: total("totalIndexSize"),
        indexes,
        capped: parts
            .iter()
            .any(|part| part.get_bool("capped").unwrap_or(false)),
    })
}

async fn indexes(client: &Client, database: &str, collection: &str) -> Result<Vec<IndexSummary>> {
    let mut cursor = client
        .database(database)
        .run_cursor_command(doc! {"listIndexes": collection})
        .await
        .map_err(errors::driver)?;
    let mut indexes = Vec::new();
    while cursor.advance().await.map_err(errors::driver)? {
        let index: Document = cursor.deserialize_current().map_err(errors::driver)?;
        indexes.push(IndexSummary {
            name: index.get_str("name").unwrap_or_default().to_string(),
            keys: Bson::Document(index.get_document("key").cloned().unwrap_or_default())
                .into_canonical_extjson(),
            unique: index.get_bool("unique").unwrap_or(false),
        });
    }
    Ok(indexes)
}

/// A number the server may send as any of its numeric types.
pub fn number(document: &Document, field: &str) -> Option<i64> {
    match document.get(field)? {
        Bson::Int32(value) => Some(i64::from(*value)),
        Bson::Int64(value) => Some(*value),
        Bson::Double(value) if value.is_finite() => Some(*value as i64),
        _ => None,
    }
}

/// Names MongoDB would refuse, refused first with a clear message.
pub fn check_name(name: &str, what: &str) -> Result<()> {
    if name.is_empty()
        || name.contains('\0')
        || (what == "database" && name.contains(['/', '\\', '.', ' ', '"', '$']))
    {
        return Err(Error::Validation(format!("Invalid {what} name: {name:?}")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(name: &str) -> CollectionSummary {
        CollectionSummary {
            name: name.into(),
            kind: "collection".into(),
            gridfs: None,
            view_on: None,
            capped: false,
        }
    }

    #[test]
    fn marks_gridfs_buckets_only_with_both_collections() {
        let mut collections = vec![
            summary("fs.files"),
            summary("fs.chunks"),
            summary("photos.files"),
            summary("orders"),
        ];
        mark_gridfs(&mut collections);
        let buckets: Vec<Option<&str>> = collections.iter().map(|c| c.gridfs.as_deref()).collect();
        assert_eq!(buckets, vec![Some("fs"), Some("fs"), None, None]);
    }

    #[test]
    fn reads_numbers_of_any_type_and_refuses_bad_names() {
        let document = doc! {"a": 1, "b": 2_i64, "c": 2.5, "d": "x"};
        assert_eq!(number(&document, "a"), Some(1));
        assert_eq!(number(&document, "b"), Some(2));
        assert_eq!(number(&document, "c"), Some(2));
        assert_eq!(number(&document, "d"), None);
        assert!(check_name("shop", "database").is_ok());
        assert!(check_name("system.profile", "collection").is_ok());
        assert!(check_name("a.b", "database").is_err());
        assert!(check_name("", "collection").is_err());
    }
}
