//! The database profiler: its level and `slowms`, read and changed, and the slowest
//! operations it recorded in `system.profile`.
use crate::{
    browse::{check_name, number},
    errors, limits,
};
use bson::{Bson, Document, doc};
use mongodb::{Client, options::FindOptions};
use nexo_application::ports::{ProfileEntry, ProfileStatus};
use nexo_domain::Result;

/// Bytes of a recorded command sent to the interface; larger ones are left out.
const COMMAND_BYTES: usize = 64 * 1024;
/// Fields of a recorded command that only matter to the server's sessions and clock.
const SESSION_FIELDS: [&str; 5] = ["lsid", "$clusterTime", "txnNumber", "autocommit", "$audit"];

pub async fn profile(
    client: &Client,
    database: &str,
    set: Option<(i64, Option<i64>)>,
) -> Result<ProfileStatus> {
    check_name(database, "database")?;
    let handle = client.database(database);
    if let Some((level, slowms)) = set {
        let mut command = doc! {"profile": level};
        if let Some(slowms) = slowms {
            command.insert("slowms", slowms);
        }
        handle.run_command(command).await.map_err(errors::driver)?;
    }
    // `profile` answers with the settings it had before: read them again after a change.
    let answer = handle
        .run_command(doc! {"profile": -1})
        .await
        .map_err(errors::driver)?;
    Ok(ProfileStatus {
        level: number(&answer, "was").unwrap_or(0),
        slowms: number(&answer, "slowms").unwrap_or(100),
        sample_rate: answer.get_f64("sampleRate").ok(),
    })
}

pub async fn entries(
    client: &Client,
    database: &str,
    collection: Option<&str>,
    limit: u64,
) -> Result<Vec<ProfileEntry>> {
    check_name(database, "database")?;
    let filter = match collection {
        Some(collection) => {
            check_name(collection, "collection")?;
            doc! {"ns": format!("{database}.{collection}")}
        }
        // Reading the profile is not an operation of the person's.
        None => doc! {"ns": {"$ne": format!("{database}.system.profile")}},
    };
    let mut options = FindOptions::default();
    options.sort = Some(doc! {"millis": -1, "ts": -1});
    options.limit = Some(i64::try_from(limit).unwrap_or(i64::MAX));
    options.max_time = Some(limits::OPERATION);
    let mut cursor = client
        .database(database)
        .collection::<Document>("system.profile")
        .find(filter)
        .with_options(options)
        .await
        .map_err(errors::driver)?;
    let mut entries = Vec::new();
    while cursor.advance().await.map_err(errors::driver)? {
        entries.push(entry(cursor.deserialize_current().map_err(errors::driver)?));
    }
    Ok(entries)
}

/// An entry of `system.profile` as the interface lists it.
fn entry(mut recorded: Document) -> ProfileEntry {
    let op = recorded.get_str("op").unwrap_or_default().to_string();
    // A `getMore` continues a query: the command that opened the cursor tells which.
    let command = ["originatingCommand", "command", "query"]
        .into_iter()
        .filter(|field| *field != "originatingCommand" || op == "getmore")
        .find_map(|field| match recorded.remove(field) {
            Some(Bson::Document(command)) => Some(command),
            _ => None,
        })
        .and_then(|mut command| {
            for field in SESSION_FIELDS {
                command.remove(field);
            }
            let value = Bson::Document(command).into_canonical_extjson();
            (serde_json::to_vec(&value).map_or(0, |text| text.len()) <= COMMAND_BYTES)
                .then_some(value)
        });
    ProfileEntry {
        ns: recorded.get_str("ns").unwrap_or_default().to_string(),
        millis: number(&recorded, "millis").unwrap_or(0),
        ts: recorded
            .get_datetime("ts")
            .ok()
            .and_then(|ts| ts.try_to_rfc3339_string().ok()),
        plan_summary: recorded.get_str("planSummary").ok().map(str::to_string),
        docs_examined: number(&recorded, "docsExamined"),
        keys_examined: number(&recorded, "keysExamined"),
        returned: number(&recorded, "nreturned"),
        command,
        op,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_an_entry_and_the_command_of_a_get_more() {
        let read = entry(doc! {
            "op": "query", "ns": "shop.orders", "millis": 120_i32,
            "ts": bson::DateTime::from_millis(1_704_164_645_006),
            "planSummary": "COLLSCAN", "docsExamined": 100_000_i64, "keysExamined": 0,
            "nreturned": 3,
            "command": {"find": "orders", "filter": {"status": "A"}, "lsid": {"id": 1},
                        "$db": "shop"},
        });
        assert_eq!(read.millis, 120);
        assert_eq!(read.ts.as_deref(), Some("2024-01-02T03:04:05.006Z"));
        assert_eq!(read.docs_examined, Some(100_000));
        assert_eq!(read.returned, Some(3));
        assert_eq!(
            read.command,
            Some(json!({"find": "orders", "filter": {"status": "A"}, "$db": "shop"}))
        );
        let more = entry(doc! {
            "op": "getmore", "ns": "shop.orders", "millis": 5,
            "command": {"getMore": 1_i64, "collection": "orders"},
            "originatingCommand": {"find": "orders", "filter": {"n": {"$gt": 1}}},
        });
        assert_eq!(more.command.unwrap()["find"], "orders");
        let huge = entry(doc! {
            "op": "insert", "ns": "shop.orders", "millis": 1,
            "command": {"insert": "orders", "documents": ["x".repeat(COMMAND_BYTES)]},
        });
        assert_eq!(huge.command, None, "large commands are left out");
    }
}
