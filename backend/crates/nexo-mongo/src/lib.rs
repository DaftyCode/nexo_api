//! MongoDB adapter: implements the application's document database port with the official
//! driver. Nothing outside this crate depends on `mongodb`; `nexo-server` composes it.
//!
//! The design (dependencies, egress policy, certificates, limits, redaction) is written in
//! `docs/ARCHITECTURE.md`, section "MongoDB".
mod browse;
mod connection;
mod errors;
mod query;
mod tls;

use async_trait::async_trait;
use mongodb::{
    Client,
    bson::{Document, doc},
    options::{ClientOptions, ServerAddress},
};
use nexo_application::ports::{
    CollectionStats, CollectionSummary, ConnectionReport, CountRequest, DatabaseConnection,
    DatabaseHost, DatabaseSummary, DocumentDatabase, DocumentPage, FindRequest, NetworkPolicy,
};
use nexo_domain::{Error, Result};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Instant,
};
use tls::TlsFiles;

/// Limits of every connection, so the interface and the engine stay responsive.
pub mod limits {
    use std::time::Duration;
    /// How long to wait for a server to answer before giving up on it.
    pub const SERVER_SELECTION: Duration = Duration::from_secs(10);
    /// How long to wait to open a connection.
    pub const CONNECT: Duration = Duration::from_secs(10);
    /// How long one operation may run before it is cancelled (`maxTimeMS`).
    pub const OPERATION: Duration = Duration::from_secs(60);
    /// Documents in a page of results.
    pub const PAGE_DOCUMENTS: u64 = 1_000;
    /// Bytes of results sent to the interface at once.
    pub const RESPONSE_BYTES: usize = 16 * 1024 * 1024;
    /// Connections per server: one person, a few panels.
    pub const POOL: u32 = 4;
    /// How long an unused connection, or the cursor of a page nobody reads, stays open.
    pub const IDLE: Duration = Duration::from_secs(10 * 60);
    /// Connections kept open at once.
    pub const CLIENTS: usize = 8;
    /// Cursors kept open at once; the oldest is closed first.
    pub const CURSORS: usize = 32;
}

/// A connection kept open for the explorer, with the certificates it was opened with.
struct Open {
    client: Client,
    /// The database named in the URI, listed when the user may not list them all.
    default_database: Option<String>,
    used: Instant,
    _files: TlsFiles,
}

/// The MongoDB adapter. Certificates of a connection are written under `tls_directory` while
/// it is open.
pub struct MongoAdapter {
    tls_directory: PathBuf,
    policy: Arc<dyn NetworkPolicy>,
    /// Open connections, by everything that identifies them (secrets included, in memory).
    clients: tokio::sync::Mutex<HashMap<String, Open>>,
    cursors: Mutex<HashMap<String, query::Stored>>,
    running: Mutex<HashMap<String, query::Running>>,
}

impl MongoAdapter {
    pub fn new(data: &Path, policy: Arc<dyn NetworkPolicy>) -> Self {
        let tls_directory = data.join("mongo-tls");
        // Certificates left by a previous run that ended abruptly.
        let _ = std::fs::remove_dir_all(&tls_directory);
        Self {
            tls_directory,
            policy,
            clients: Default::default(),
            cursors: Default::default(),
            running: Default::default(),
        }
    }

    /// An open connection for this one, opened (and every server checked) when there is
    /// none. Connections unused for a while are closed.
    async fn client(&self, connection: &DatabaseConnection) -> Result<(Client, Option<String>)> {
        let key = format!(
            "{}\0{:?}\0{:?}\0{:?}\0{:?}\0{:?}",
            connection.uri,
            connection.password,
            connection.ca_pem,
            connection.cert_pem,
            connection.key_pem,
            connection.secret_hosts,
        );
        {
            let mut clients = self.clients.lock().await;
            clients.retain(|_, open| open.used.elapsed() < limits::IDLE);
            if let Some(open) = clients.get_mut(&key) {
                open.used = Instant::now();
                return Ok((open.client.clone(), open.default_database.clone()));
            }
        }
        let opened = self.connect(connection).await?;
        let mut clients = self.clients.lock().await;
        if clients.len() >= limits::CLIENTS
            && let Some(oldest) = clients
                .iter()
                .min_by_key(|(_, open)| open.used)
                .map(|(key, _)| key.clone())
        {
            clients.remove(&oldest);
        }
        // Another request may have opened it meanwhile: that one stays.
        let open = clients.entry(key).or_insert(Open {
            client: opened.client,
            default_database: opened.options.default_database.clone(),
            used: Instant::now(),
            _files: opened.files,
        });
        Ok((open.client.clone(), open.default_database.clone()))
    }

    /// Why Nexo may not reach a server, if it may not: a secret of the connection that is
    /// not allowed there, or the egress policy.
    async fn refusal(
        &self,
        host: &str,
        port: u16,
        connection: &DatabaseConnection,
    ) -> Option<String> {
        if let Some((name, _)) = connection
            .secret_hosts
            .iter()
            .find(|(_, allowed)| !allowed.allows(host))
        {
            return Some(format!("secret {name} cannot be sent to {host}"));
        }
        self.policy
            .check_destination(host, port)
            .await
            .err()
            .map(|error| error.to_string())
    }

    async fn run_test(&self, connection: DatabaseConnection) -> Result<ConnectionReport> {
        let Opened {
            client,
            options,
            files: _files,
            seeds,
            direct,
            mut refusals,
        } = self.connect(&connection).await?;
        let result = describe(
            self,
            &client,
            (&options, &connection),
            &seeds,
            direct,
            &mut refusals,
        )
        .await;
        client.shutdown().await;
        result
    }

    /// Checks every server of a connection against the egress policy and the secrets'
    /// allowed domains, and opens it.
    async fn connect(&self, connection: &DatabaseConnection) -> Result<Opened> {
        let (options, files) = connection::options(connection, &self.tls_directory).await?;
        let seeds: Vec<(String, u16)> = options.hosts.iter().map(address).collect::<Result<_>>()?;
        let mut refusals: HashMap<String, Option<String>> = HashMap::new();
        for (host, port) in &seeds {
            if let Some(reason) = self.refusal(host, *port, connection).await {
                return Err(Error::Validation(format!(
                    "Nexo may not connect to {host}:{port}: {reason}"
                )));
            }
            refusals.insert(format!("{host}:{port}"), None);
        }

        // The driver connects to every server a replica set announces, and nothing can filter
        // them. When some destinations are refused (by the policy or a secret's allowed
        // domains), the first server is asked for them first, connected to directly.
        let verify = self.policy.restrictive() || !connection.secret_hosts.is_empty();
        let mut direct = false;
        let client = if verify
            && options.load_balanced != Some(true)
            && options.direct_connection != Some(true)
        {
            let mut first = options.clone();
            first.hosts.truncate(1);
            first.direct_connection = Some(true);
            let probe = client(first)?;
            let hello = command(&probe, doc! {"hello": 1}).await;
            probe.shutdown().await;
            let mut refused = false;
            for (member, _) in members(&hello?) {
                let (host, port) =
                    address(&ServerAddress::parse(&member).map_err(errors::driver)?)?;
                let key = format!("{host}:{port}");
                if refusals.contains_key(&key) {
                    continue;
                }
                let reason = self.refusal(&host, port, connection).await;
                refused |= reason.is_some();
                refusals.insert(key, reason);
            }
            if refused {
                direct = true;
                let mut first = options.clone();
                first.hosts.truncate(1);
                first.direct_connection = Some(true);
                client(first)?
            } else {
                client(options.clone())?
            }
        } else {
            client(options.clone())?
        };
        Ok(Opened {
            client,
            options,
            files,
            seeds,
            direct,
            refusals,
        })
    }
}

/// A connection just opened, with what was checked to open it.
struct Opened {
    client: Client,
    options: ClientOptions,
    files: TlsFiles,
    seeds: Vec<(String, u16)>,
    direct: bool,
    refusals: HashMap<String, Option<String>>,
}

/// Waits for an operation for at most the operation limit (and a little more, so the
/// server's `maxTimeMS` answers first).
async fn within<T>(work: impl std::future::Future<Output = Result<T>>) -> Result<T> {
    tokio::time::timeout(limits::OPERATION + std::time::Duration::from_secs(5), work)
        .await
        .map_err(|_| {
            Error::Validation(format!(
                "The server did not answer within {} seconds",
                limits::OPERATION.as_secs()
            ))
        })?
}

#[async_trait]
impl DocumentDatabase for MongoAdapter {
    async fn test(&self, connection: DatabaseConnection) -> Result<ConnectionReport> {
        within(self.run_test(connection)).await
    }
    async fn databases(&self, connection: DatabaseConnection) -> Result<Vec<DatabaseSummary>> {
        within(async {
            let (client, default_database) = self.client(&connection).await?;
            browse::databases(&client, default_database).await
        })
        .await
    }
    async fn collections(
        &self,
        connection: DatabaseConnection,
        database: &str,
    ) -> Result<Vec<CollectionSummary>> {
        within(async {
            let (client, _) = self.client(&connection).await?;
            browse::collections(&client, database).await
        })
        .await
    }
    async fn stats(
        &self,
        connection: DatabaseConnection,
        database: &str,
        collection: &str,
    ) -> Result<CollectionStats> {
        within(async {
            let (client, _) = self.client(&connection).await?;
            browse::stats(&client, database, collection).await
        })
        .await
    }
    async fn find(
        &self,
        connection: DatabaseConnection,
        request: FindRequest,
    ) -> Result<DocumentPage> {
        let (client, _) = within(self.client(&connection)).await?;
        query::find(self, client, request).await
    }
    async fn more(&self, cursor: &str, id: &str, page_size: u64) -> Result<DocumentPage> {
        query::more(self, cursor, id, page_size).await
    }
    async fn count(&self, connection: DatabaseConnection, request: CountRequest) -> Result<u64> {
        let (client, _) = within(self.client(&connection)).await?;
        query::count(self, client, request).await
    }
    async fn cancel(&self, id: &str) -> Result<bool> {
        Ok(query::cancel(self, id).await)
    }
    async fn close(&self, cursor: &str) -> Result<()> {
        // Dropping a cursor tells the server to close it.
        self.cursors
            .lock()
            .map_err(|_| Error::Infrastructure("cursor list unavailable".into()))?
            .remove(cursor);
        Ok(())
    }
}

fn client(options: ClientOptions) -> Result<Client> {
    Client::with_options(options).map_err(errors::driver)
}

async fn command(client: &Client, command: Document) -> Result<Document> {
    client
        .database("admin")
        .run_command(command)
        .await
        .map_err(errors::driver)
}

/// The host and port of a server address; only TCP servers are supported.
fn address(address: &ServerAddress) -> Result<(String, u16)> {
    match address {
        ServerAddress::Tcp { host, port } => Ok((host.clone(), port.unwrap_or(27017))),
        _ => Err(Error::Validation(
            "Only servers reached over TCP are supported".into(),
        )),
    }
}

/// The members a replica set's `hello` announces, with their role.
fn members(hello: &Document) -> Vec<(String, &'static str)> {
    let primary = hello.get_str("primary").ok();
    let list = |field: &str| -> Vec<String> {
        hello
            .get_array(field)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    };
    let mut members: Vec<(String, &'static str)> = list("hosts")
        .into_iter()
        .map(|host| {
            let role = if Some(host.as_str()) == primary {
                "primary"
            } else {
                "secondary"
            };
            (host, role)
        })
        .collect();
    members.extend(list("passives").into_iter().map(|host| (host, "passive")));
    members.extend(list("arbiters").into_iter().map(|host| (host, "arbiter")));
    members
}

/// Pings and describes the deployment: version, topology and each server with whether Nexo
/// may reach it.
async fn describe(
    adapter: &MongoAdapter,
    client: &Client,
    (options, connection): (&ClientOptions, &DatabaseConnection),
    seeds: &[(String, u16)],
    direct: bool,
    refusals: &mut HashMap<String, Option<String>>,
) -> Result<ConnectionReport> {
    let hello = command(client, doc! {"hello": 1}).await?;
    let started = Instant::now();
    command(client, doc! {"ping": 1}).await?;
    let ping_ms = started.elapsed().as_millis() as u64;
    let build = command(client, doc! {"buildInfo": 1}).await?;

    let replica_set = hello.get_str("setName").ok().map(str::to_string);
    let load_balanced = options.load_balanced == Some(true);
    let sharded = hello.get_str("msg").ok() == Some("isdbgrid");
    let topology = if load_balanced {
        "loadBalanced"
    } else if replica_set.is_some() {
        "replicaSet"
    } else if sharded {
        "sharded"
    } else {
        "standalone"
    };
    let mut listed: Vec<(String, &'static str)> = if replica_set.is_some() {
        members(&hello)
    } else {
        let role = match topology {
            "loadBalanced" => "loadBalancer",
            "sharded" => "mongos",
            _ => "standalone",
        };
        seeds
            .iter()
            .map(|(host, port)| (format!("{host}:{port}"), role))
            .collect()
    };
    if listed.is_empty() {
        listed = seeds
            .iter()
            .map(|(host, port)| (format!("{host}:{port}"), "standalone"))
            .collect();
    }
    let mut hosts = Vec::new();
    for (member, role) in listed {
        let reason = match refusals.get(&member) {
            Some(reason) => reason.clone(),
            None => {
                let parsed = ServerAddress::parse(&member)
                    .map_err(errors::driver)
                    .and_then(|parsed| address(&parsed));
                let reason = match parsed {
                    Ok((host, port)) => adapter.refusal(&host, port, connection).await,
                    Err(error) => Some(error.to_string()),
                };
                refusals.insert(member.clone(), reason.clone());
                reason
            }
        };
        hosts.push(DatabaseHost {
            address: member,
            role: role.into(),
            allowed: reason.is_none(),
            reason,
        });
    }

    let credential = options.credential.as_ref();
    Ok(ConnectionReport {
        server_version: build.get_str("version").unwrap_or("unknown").to_string(),
        topology: topology.into(),
        replica_set,
        flavor: flavor(&build, &hello),
        hosts,
        ping_ms,
        direct,
        tls: matches!(options.tls, Some(mongodb::options::Tls::Enabled(_))),
        auth_mechanism: credential.map(|credential| {
            credential
                .mechanism
                .as_ref()
                .map(|mechanism| mechanism.as_str().to_string())
                .unwrap_or_else(|| "SCRAM".into())
        }),
    })
}

/// Compatible servers that say what they are.
fn flavor(build: &Document, hello: &Document) -> Option<String> {
    if build.contains_key("ferretdb") || build.contains_key("ferretdbVersion") {
        return Some("FerretDB".into());
    }
    if hello.contains_key("isCosmos") || build.contains_key("isCosmos") {
        return Some("Azure Cosmos DB".into());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use nexo_domain::hosts::AllowedHosts;

    /// A policy that refuses the hosts named `private…`.
    struct Policy {
        restrictive: bool,
    }
    #[async_trait]
    impl NetworkPolicy for Policy {
        async fn check_destination(&self, host: &str, _: u16) -> Result<()> {
            if host.starts_with("private") {
                return Err(Error::Validation(format!(
                    "Destination {host} is blocked by the egress policy"
                )));
            }
            Ok(())
        }
        fn restrictive(&self) -> bool {
            self.restrictive
        }
    }
    fn adapter(restrictive: bool) -> MongoAdapter {
        MongoAdapter::new(
            &std::env::temp_dir().join(format!("nexo-mongo-{}", uuid::Uuid::new_v4())),
            Arc::new(Policy { restrictive }),
        )
    }

    #[tokio::test]
    async fn refuses_seeds_of_the_policy_and_of_secrets_before_connecting() {
        let error = adapter(true)
            .test(DatabaseConnection {
                uri: "mongodb://public.test,private.test:27018/?serverSelectionTimeoutMS=100"
                    .into(),
                ..Default::default()
            })
            .await
            .unwrap_err()
            .to_string();
        assert_eq!(
            error,
            "Nexo may not connect to private.test:27018: Destination private.test is blocked by the egress policy"
        );
        let error = adapter(false)
            .test(DatabaseConnection {
                uri: "mongodb://ana@db.other.test/?serverSelectionTimeoutMS=100".into(),
                password: Some("secret".into()),
                secret_hosts: vec![(
                    "mongo-pass".into(),
                    AllowedHosts::parse(&["*.example.com"]).unwrap(),
                )],
                ..Default::default()
            })
            .await
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("secret mongo-pass cannot be sent to db.other.test"),
            "{error}"
        );
    }

    #[tokio::test]
    async fn an_unreachable_server_is_explained() {
        // Port 9 (discard) on loopback: nothing answers there.
        let error = adapter(false)
            .test(DatabaseConnection {
                uri: "mongodb://127.0.0.1:9/?serverSelectionTimeoutMS=300&connectTimeoutMS=300"
                    .into(),
                ..Default::default()
            })
            .await
            .unwrap_err()
            .to_string();
        assert!(error.starts_with("No server answered:"), "{error}");
    }

    #[test]
    fn reads_the_members_of_a_replica_set() {
        let hello = doc! {
            "setName": "rs0", "primary": "a:1",
            "hosts": ["a:1", "b:2"], "passives": ["c:3"], "arbiters": ["d:4"],
        };
        assert_eq!(
            members(&hello),
            vec![
                ("a:1".to_string(), "primary"),
                ("b:2".to_string(), "secondary"),
                ("c:3".to_string(), "passive"),
                ("d:4".to_string(), "arbiter"),
            ]
        );
        assert!(members(&doc! {"ok": 1}).is_empty());
        assert_eq!(
            flavor(&doc! {"ferretdb": {"version": "2.0"}}, &doc! {}).as_deref(),
            Some("FerretDB")
        );
        assert_eq!(flavor(&doc! {"version": "8.0.4"}, &doc! {}), None);
    }

    /// The driver builds its TLS settings from rustls' default aws-lc-rs provider: it must
    /// prefer the post-quantum key exchange, as every other connection of Nexo does.
    #[test]
    fn tls_prefers_post_quantum_key_exchange() {
        let provider = rustls::crypto::aws_lc_rs::default_provider();
        assert_eq!(
            provider.kx_groups[0].name(),
            rustls::NamedGroup::X25519MLKEM768
        );
    }
}
