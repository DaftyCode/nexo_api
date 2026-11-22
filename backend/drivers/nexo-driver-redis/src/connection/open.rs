//! Opening a connection: the server, the master a set of Sentinels names (asked of each
//! Sentinel through the host's resolver), or a cluster's first nodes.
use super::{Conn, HostResolver, PORT, Target, failure, servers, tls};
use nexo_driver_sdk::{DriverError, HostLink, Result, protocol::ConnectParams};
use redis::{
    ConnectionAddr, ConnectionInfo, IntoConnectionInfo, RedisConnectionInfo, TlsCertificates,
};

/// Where a server is, as the library writes it.
fn info(
    host: &str,
    port: u16,
    tls: Option<bool>,
    redis: &RedisConnectionInfo,
) -> Result<ConnectionInfo> {
    let address = match tls {
        None => ConnectionAddr::Tcp(host.to_owned(), port),
        Some(insecure) => ConnectionAddr::TcpTls {
            host: host.to_owned(),
            port,
            insecure,
            tls_params: None,
        },
    };
    Ok(address
        .into_connection_info()
        .map_err(failure)?
        .set_redis_settings(redis.clone()))
}

/// The master a set of Sentinels names, asked of each one until one answers.
async fn sentinel_master(
    resolver: &HostResolver,
    servers: &[(String, u16)],
    master: &str,
    tls: Option<(bool, &TlsCertificates)>,
) -> Result<(String, u16)> {
    let mut last = DriverError::network("No Sentinel answered");
    for (host, port) in servers {
        let target = Target {
            infos: vec![info(
                host,
                *port,
                tls.map(|(insecure, _)| insecure),
                &RedisConnectionInfo::default(),
            )?],
            certificates: tls.map(|(_, certificates)| certificates.clone()),
            cluster: false,
            resolver: resolver.clone(),
        };
        let asked = async {
            let connection = target.open(None).await?;
            let mut command = redis::cmd("SENTINEL");
            command.arg("GET-MASTER-ADDR-BY-NAME").arg(master);
            let answer: Option<(String, u16)> =
                redis::from_redis_value(connection.run(&command).await.map_err(failure)?)
                    .map_err(failure)?;
            answer.ok_or_else(|| {
                DriverError::invalid(format!("The Sentinels know no master {master}"))
            })
        };
        match asked.await {
            Ok(found) => return Ok(found),
            Err(error) => last = error,
        }
    }
    Err(last)
}

/// Opens a connection as its parameters say.
pub(crate) async fn open(link: &HostLink, params: &ConnectParams) -> Result<(Conn, Target, i64)> {
    tls::install();
    let resolver = HostResolver {
        link: link.clone(),
        connection: params.connection.clone(),
    };
    let db: i64 = match params
        .database
        .as_deref()
        .map(str::trim)
        .filter(|db| !db.is_empty())
    {
        Some(db) => db
            .trim_start_matches("db")
            .parse()
            .map_err(|_| DriverError::invalid(format!("The database is a number: {db}")))?,
        None => 0,
    };
    let mut redis = RedisConnectionInfo::default().set_db(db);
    if let Some(user) = params.user.as_deref().filter(|user| !user.is_empty()) {
        redis = redis.set_username(user);
    }
    if let Some(password) = params
        .password
        .as_deref()
        .filter(|password| !password.is_empty())
    {
        redis = redis.set_password(password);
    }
    let tls = tls::certificates(&params.tls)?;
    let insecure = tls.as_ref().map(|(insecure, _)| *insecure);
    let servers = servers(params.host.as_deref().unwrap_or("localhost"), params.port);
    let mode = params
        .options
        .get("mode")
        .map(String::as_str)
        .unwrap_or("standalone");
    let (infos, cluster) = match mode {
        "" | "standalone" => {
            let (host, port) = servers
                .first()
                .cloned()
                .unwrap_or(("localhost".into(), PORT));
            (vec![info(&host, port, insecure, &redis)?], false)
        }
        "sentinel" => {
            let master = params
                .options
                .get("master")
                .map(String::as_str)
                .unwrap_or("mymaster");
            let tls = tls
                .as_ref()
                .map(|(insecure, certificates)| (*insecure, certificates));
            let (host, port) = sentinel_master(&resolver, &servers, master, tls).await?;
            (vec![info(&host, port, insecure, &redis)?], false)
        }
        "cluster" => {
            if db != 0 {
                return Err(DriverError::invalid("A cluster has only the database 0"));
            }
            let infos = servers
                .iter()
                .map(|(host, port)| info(host, *port, insecure, &redis))
                .collect::<Result<Vec<_>>>()?;
            (infos, true)
        }
        other => {
            return Err(DriverError::invalid(format!(
                "Unknown mode {other}: standalone, sentinel or cluster"
            )));
        }
    };
    let target = Target {
        infos,
        certificates: tls.map(|(_, certificates)| certificates),
        cluster,
        resolver,
    };
    let connection = target.open(None).await?;
    Ok((connection, target, db))
}
