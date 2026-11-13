//! An open connection of the driver: its client, the other databases the tree opened, its
//! transaction, its cursors and the statements running in it.
use crate::{
    errors::database,
    session::{Opened, open},
    values::Source,
};
use nexo_driver_sdk::{
    DriverError, HostLink, Result,
    protocol::{ConnectParams, ServerInfo, TlsMode},
};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, atomic::AtomicU64},
};
use tokio_postgres::Client;

#[derive(Debug, Clone, Copy)]
pub(crate) struct TxState {
    pub auto: bool,
    pub open: bool,
}

/// A cursor left open: how many rows it gave and how many it may give in all.
pub(crate) struct Cursor {
    pub name: String,
    pub read: u64,
    pub max: Option<u64>,
}

pub(crate) struct PgConnection {
    pub params: ConnectParams,
    pub link: HostLink,
    pub main: Opened,
    /// The database the connection opened.
    pub database: String,
    /// `server_version_num`: catalogs differ between versions.
    pub version: i32,
    others: tokio::sync::Mutex<HashMap<String, Arc<Opened>>>,
    pub state: Mutex<TxState>,
    /// Open cursors, the oldest first.
    pub cursors: Mutex<Vec<Cursor>>,
    pub running: Mutex<HashSet<String>>,
    pub counter: AtomicU64,
    /// Where the columns of a table come from, by table and column number.
    pub sources: Mutex<HashMap<u32, HashMap<i16, Source>>>,
}

fn product(version: &str) -> Option<String> {
    if version.contains("CockroachDB") {
        Some("CockroachDB".into())
    } else if version.contains("Redshift") {
        Some("Amazon Redshift".into())
    } else if version.contains("-YB-") {
        Some("YugabyteDB".into())
    } else {
        None
    }
}

impl PgConnection {
    /// Opens a connection and reads what the server says about itself.
    pub async fn open(link: HostLink, params: ConnectParams) -> Result<(Self, ServerInfo)> {
        let main = open(&link, &params, None).await?;
        let row = main
            .client
            .query_one(
                "SELECT version(), current_database()::text, current_user::text, \
                 current_setting('server_version'), current_setting('server_version_num')::int",
                &[],
            )
            .await
            .map_err(|error| database(error, None))?;
        let (full, database_name): (String, String) = (row.get(0), row.get(1));
        let (user, version, number): (String, String, i32) = (row.get(2), row.get(3), row.get(4));
        let tls = match params.tls.mode {
            TlsMode::Disable => false,
            TlsMode::Require | TlsMode::Verify => true,
            // Prefer falls back to plain text: the server says which one it took.
            TlsMode::Prefer => main
                .client
                .query_opt(
                    "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
                    &[],
                )
                .await
                .ok()
                .flatten()
                .is_some_and(|row| row.get::<_, bool>(0)),
        };
        let info = ServerInfo {
            server_version: version
                .split_whitespace()
                .next()
                .unwrap_or_default()
                .to_owned(),
            product: product(&full),
            database: Some(database_name.clone()),
            user: Some(user),
            tls,
        };
        let connection = Self {
            params,
            link,
            main,
            database: database_name,
            version: number,
            others: tokio::sync::Mutex::default(),
            state: Mutex::new(TxState {
                auto: true,
                open: false,
            }),
            cursors: Mutex::default(),
            running: Mutex::default(),
            counter: AtomicU64::new(0),
            sources: Mutex::default(),
        };
        Ok((connection, info))
    }

    /// The client of a database of the server: the connection's own, or another one the tree
    /// opened (PostgreSQL connects to one database at a time).
    pub async fn client(&self, database: &str) -> Result<ClientRef<'_>> {
        if database == self.database {
            return Ok(ClientRef::Main(&self.main.client));
        }
        let mut others = self.others.lock().await;
        if let Some(opened) = others
            .get(database)
            .filter(|opened| !opened.client.is_closed())
        {
            return Ok(ClientRef::Other(opened.clone()));
        }
        let opened = Arc::new(open(&self.link, &self.params, Some(database)).await?);
        others.insert(database.to_owned(), opened.clone());
        Ok(ClientRef::Other(opened))
    }

    /// Where the columns of the tables `tables` come from, read once per table.
    pub async fn sources(&self, tables: Vec<u32>) -> HashMap<(u32, i16), Source> {
        let missing: Vec<u32> = {
            let known = self.sources.lock().unwrap();
            tables
                .iter()
                .copied()
                .filter(|table| !known.contains_key(table))
                .collect()
        };
        if !missing.is_empty() {
            let query = "SELECT c.oid, n.nspname::text, c.relname::text, a.attnum, a.attname::text, \
                 coalesce(a.attnum = ANY(i.indkey), false) \
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                 JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped \
                 LEFT JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary \
                 WHERE c.oid = ANY($1)";
            if let Ok(rows) = self.main.client.query(query, &[&missing]).await {
                let mut known = self.sources.lock().unwrap();
                for table in &missing {
                    known.entry(*table).or_default();
                }
                for row in rows {
                    let (table, schema, name): (u32, String, String) =
                        (row.get(0), row.get(1), row.get(2));
                    let (position, column, key): (i16, String, bool) =
                        (row.get(3), row.get(4), row.get(5));
                    let source = Source {
                        schema,
                        table: name,
                        column,
                        key,
                    };
                    known.entry(table).or_default().insert(position, source);
                }
            }
        }
        let known = self.sources.lock().unwrap();
        let mut found = HashMap::new();
        for table in tables {
            for (position, source) in known.get(&table).into_iter().flatten() {
                found.insert((table, *position), source.clone());
            }
        }
        found
    }

    pub fn closed(&self) -> bool {
        self.main.client.is_closed()
    }
}

/// A client the connection lends: its own, or one of another database.
pub(crate) enum ClientRef<'a> {
    Main(&'a Client),
    Other(Arc<Opened>),
}
impl std::ops::Deref for ClientRef<'_> {
    type Target = Client;
    fn deref(&self) -> &Client {
        match self {
            Self::Main(client) => client,
            Self::Other(opened) => &opened.client,
        }
    }
}

pub(crate) fn not_open() -> DriverError {
    DriverError::invalid("The connection is not open")
}
