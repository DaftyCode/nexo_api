//! What the server says of itself (`INFO`): its version and product (Redis or Valkey), and
//! its databases with their keys.
use crate::{
    connection::{Conn, failure},
    reply::text,
};
use nexo_driver_sdk::{
    Result,
    protocol::{ConnectParams, ServerInfo, TlsMode, TreeNode},
};
use redis::cmd;
use std::collections::BTreeMap;

/// The fields of an `INFO` section.
pub(crate) fn fields(info: &str) -> BTreeMap<String, String> {
    info.lines()
        .filter(|line| !line.starts_with('#'))
        .filter_map(|line| line.trim().split_once(':'))
        .map(|(name, value)| (name.to_owned(), value.to_owned()))
        .collect()
}

async fn section(connection: &Conn, name: &str) -> Result<BTreeMap<String, String>> {
    let reply = connection
        .run(cmd("INFO").arg(name))
        .await
        .map_err(failure)?;
    // A cluster answers with each node's: the first one is enough here.
    let text = match &reply {
        redis::Value::Map(pairs) => pairs.first().and_then(|(_, value)| text(value)),
        other => text(other),
    };
    Ok(fields(&text.unwrap_or_default()))
}

pub(crate) async fn info(connection: &Conn, params: &ConnectParams, db: i64) -> Result<ServerInfo> {
    let server = section(connection, "server").await?;
    let valkey = server
        .get("server_name")
        .is_some_and(|name| name == "valkey");
    let version = if valkey {
        server.get("valkey_version")
    } else {
        server.get("redis_version")
    };
    let mode = server.get("redis_mode").cloned().unwrap_or_default();
    Ok(ServerInfo {
        server_version: version.cloned().unwrap_or_default(),
        product: Some(format!(
            "{} ({mode})",
            if valkey { "Valkey" } else { "Redis" }
        )),
        database: Some(format!("db{db}")),
        user: params.user.clone().filter(|user| !user.is_empty()),
        tls: params.tls.mode != TlsMode::Disable,
    })
}

/// The databases with keys, and the connection's, with how many keys each one has.
pub(crate) async fn databases(connection: &Conn, current: i64) -> Result<Vec<TreeNode>> {
    let keyspace = section(connection, "keyspace").await?;
    let mut counts: BTreeMap<i64, u64> = keyspace
        .iter()
        .filter_map(|(name, value)| {
            let db = name.strip_prefix("db")?.parse().ok()?;
            let keys = fields(&value.replace(',', "\n").replace('=', ":"))
                .get("keys")?
                .parse()
                .ok()?;
            Some((db, keys))
        })
        .collect();
    if matches!(connection, Conn::Cluster(_)) {
        counts.retain(|db, _| *db == 0);
    }
    counts.entry(current).or_insert(0);
    Ok(counts
        .into_iter()
        .map(|(db, keys)| TreeNode {
            kind: "database".into(),
            name: format!("db{db}"),
            label: format!("db{db}"),
            detail: Some(format!("{keys} keys")),
            has_children: false,
            actions: vec!["open".into()],
            system: false,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn info_is_read_by_its_fields() {
        let read = fields("# Server\r\nredis_version:7.4.1\r\nredis_mode:standalone\r\n");
        assert_eq!(read["redis_version"], "7.4.1");
        assert_eq!(read["redis_mode"], "standalone");
        let db = fields(
            &"keys=12,expires=1,avg_ttl=0"
                .replace(',', "\n")
                .replace('=', ":"),
        );
        assert_eq!(db["keys"], "12");
    }
}
