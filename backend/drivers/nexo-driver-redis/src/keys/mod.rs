//! Keys read by pages of `SCAN`, never `KEYS`, so the server is never blocked; in a cluster,
//! each primary in turn. A key's value is read by its type, its collections by pages.
use crate::{
    connection::{Conn, failure},
    reply::{cell, integer, items, raw, text},
};
use nexo_driver_sdk::{
    DriverError, Result,
    keyvalue::{KeyInfo, ScanParams, ScanResult},
};
use redis::{
    Cmd, Value,
    cluster_routing::{RoutingInfo, SingleNodeRoutingInfo},
    cmd,
};
use tokio::task::JoinSet;

/// Keys asked of each `SCAN` when the interface says nothing.
const SCAN_COUNT: u32 = 200;
/// Elements of a collection read at a time.
const PAGE: u32 = 100;
const MAX: u32 = 1000;
/// How long a page may go on with `SCAN` looking for keys that match: each round is short,
/// so the server is never blocked, and the rest comes with «load more».
const BUDGET: std::time::Duration = std::time::Duration::from_millis(300);
/// Keys each `SCAN` looks at when a pattern or a type filters them.
const FILTERED_COUNT: u32 = 1000;

/// Runs a command on one node of a cluster, or on the server.
async fn on(connection: &Conn, node: Option<&(String, u16)>, command: Cmd) -> Result<Value> {
    match (connection, node) {
        (Conn::Cluster(cluster), Some((host, port))) => {
            let routing = RoutingInfo::SingleNode(SingleNodeRoutingInfo::ByAddress {
                host: host.clone(),
                port: *port,
            });
            cluster
                .clone()
                .route_command(command, routing)
                .await
                .map_err(failure)
        }
        _ => connection.run(&command).await.map_err(failure),
    }
}

/// The primaries of a cluster, as `CLUSTER NODES` lists them.
pub(crate) async fn primaries(connection: &Conn) -> Result<Vec<(String, u16)>> {
    let nodes = connection
        .run(cmd("CLUSTER").arg("NODES"))
        .await
        .map_err(failure)?;
    let mut found: Vec<(String, u16)> = text(&nodes)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split_whitespace().collect();
            let flags = parts.get(2)?;
            if !flags.contains("master") || flags.contains("fail") {
                return None;
            }
            let address = parts.get(1)?.split(['@', ',']).next()?;
            let (host, port) = address.rsplit_once(':')?;
            Some((host.to_owned(), port.parse().ok()?))
        })
        .collect();
    found.sort();
    Ok(found)
}

/// A page of keys with their type and expiry. A cluster's cursor is `node:cursor`.
pub(crate) async fn scan(connection: &Conn, params: ScanParams) -> Result<ScanResult> {
    let nodes = match connection {
        Conn::Cluster(_) => primaries(connection).await?,
        Conn::Single(_) => Vec::new(),
    };
    let (mut node, mut cursor) = match params.cursor.as_deref().filter(|c| !c.is_empty()) {
        Some(text) => match text.split_once(':') {
            Some((node, cursor)) => (node.parse().unwrap_or(0), cursor.to_owned()),
            None => (0, text.to_owned()),
        },
        None => (0usize, "0".to_owned()),
    };
    let count = params.count.unwrap_or(SCAN_COUNT).clamp(1, MAX * 10);
    let filtered = params
        .pattern
        .as_deref()
        .is_some_and(|p| !p.is_empty() && p != "*")
        || params.kind.as_deref().is_some_and(|kind| !kind.is_empty());
    let looked = if filtered {
        count.max(FILTERED_COUNT)
    } else {
        count
    };
    let deadline = std::time::Instant::now() + BUDGET;
    let mut keys = Vec::new();
    // A page as large as asked, or a few rounds of SCAN (a pattern may match few keys): the
    // rest comes with «load more».
    while std::time::Instant::now() < deadline {
        let mut command = cmd("SCAN");
        command.arg(&cursor);
        if let Some(pattern) = params.pattern.as_deref().filter(|p| !p.is_empty()) {
            command.arg("MATCH").arg(pattern);
        }
        command.arg("COUNT").arg(looked);
        if let Some(kind) = params.kind.as_deref().filter(|kind| !kind.is_empty()) {
            command.arg("TYPE").arg(kind);
        }
        let reply = items(on(connection, nodes.get(node), command).await?);
        cursor = reply.first().and_then(text).unwrap_or_else(|| "0".into());
        keys.extend(reply.into_iter().nth(1).map(items).unwrap_or_default());
        if cursor == "0" {
            if node + 1 >= nodes.len() {
                return Ok(ScanResult {
                    keys: describe(connection, keys, params.kind).await?,
                    cursor: None,
                });
            }
            node += 1;
        }
        if keys.len() >= count as usize {
            break;
        }
    }
    let next = if nodes.is_empty() {
        cursor
    } else {
        format!("{node}:{cursor}")
    };
    Ok(ScanResult {
        keys: describe(connection, keys, params.kind).await?,
        cursor: Some(next),
    })
}

/// The type and expiry of each key, asked at once.
async fn describe(
    connection: &Conn,
    keys: Vec<Value>,
    kind: Option<String>,
) -> Result<Vec<KeyInfo>> {
    let mut tasks = JoinSet::new();
    for (at, key) in keys.into_iter().enumerate() {
        let connection = connection.clone();
        let kind = kind.clone().filter(|kind| !kind.is_empty());
        tasks.spawn(async move {
            let name = raw(&key);
            let kind = match kind {
                Some(kind) => kind,
                None => text(&connection.run(cmd("TYPE").arg(&name)).await?).unwrap_or_default(),
            };
            let ttl = integer(&connection.run(cmd("PTTL").arg(&name)).await?).unwrap_or(-1);
            redis::RedisResult::Ok((
                at,
                KeyInfo {
                    key: cell(&name),
                    kind,
                    ttl_ms: (ttl >= 0).then_some(ttl),
                },
            ))
        });
    }
    let mut found = Vec::new();
    while let Some(done) = tasks.join_next().await {
        found.push(
            done.map_err(|error| DriverError::internal(error.to_string()))?
                .map_err(failure)?,
        );
    }
    found.sort_by_key(|(at, _)| *at);
    // A key deleted between SCAN and TYPE is left out.
    Ok(found
        .into_iter()
        .map(|(_, key)| key)
        .filter(|key| key.kind != "none")
        .collect())
}

mod value;
pub(crate) use value::get;
