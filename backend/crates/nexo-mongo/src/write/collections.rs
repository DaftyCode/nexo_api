//! Creating, renaming and dropping collections and databases.
use super::*;

/// Options of a new collection Nexo passes to `create`.
pub(super) const CREATE_OPTIONS: [&str; 9] = [
    "capped",
    "size",
    "max",
    "timeseries",
    "validator",
    "validationLevel",
    "validationAction",
    "collation",
    "expireAfterSeconds",
];

pub async fn change(client: &Client, change: CollectionChange) -> Result<()> {
    match change {
        CollectionChange::Create {
            database,
            collection,
            options,
        } => {
            check_name(&database, "database")?;
            check_name(&collection, "collection")?;
            let mut command = doc! {"create": &collection};
            for (key, value) in document(options, "options")?.unwrap_or_default() {
                if !CREATE_OPTIONS.contains(&key.as_str()) {
                    return Err(Error::Validation(format!(
                        "Unknown collection option {key}"
                    )));
                }
                command.insert(key, value);
            }
            client
                .database(&database)
                .run_command(command)
                .await
                .map_err(errors::driver)?;
        }
        CollectionChange::Rename {
            database,
            collection,
            to,
        } => {
            check_name(&database, "database")?;
            check_name(&collection, "collection")?;
            check_name(&to, "collection")?;
            client
                .database("admin")
                .run_command(doc! {
                    "renameCollection": format!("{database}.{collection}"),
                    "to": format!("{database}.{to}"),
                })
                .await
                .map_err(errors::driver)?;
        }
        CollectionChange::Drop {
            database,
            collection,
        } => {
            check_name(&database, "database")?;
            check_name(&collection, "collection")?;
            client
                .database(&database)
                .collection::<Document>(&collection)
                .drop()
                .await
                .map_err(errors::driver)?;
        }
        CollectionChange::DropDatabase { database } => {
            check_name(&database, "database")?;
            client
                .database(&database)
                .drop()
                .await
                .map_err(errors::driver)?;
        }
    }
    Ok(())
}
