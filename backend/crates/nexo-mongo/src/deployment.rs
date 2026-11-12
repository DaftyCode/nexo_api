//! What a deployment is: its topology, members, version and flavor.
use super::*;

pub(super) fn client(options: ClientOptions) -> Result<Client> {
    Client::with_options(options).map_err(errors::driver)
}

pub(super) async fn command(client: &Client, command: Document) -> Result<Document> {
    client
        .database("admin")
        .run_command(command)
        .await
        .map_err(errors::driver)
}

/// The host and port of a server address; only TCP servers are supported.
pub(super) fn address(address: &ServerAddress) -> Result<(String, u16)> {
    match address {
        ServerAddress::Tcp { host, port } => Ok((host.clone(), port.unwrap_or(27017))),
        _ => Err(Error::Validation(
            "Only servers reached over TCP are supported".into(),
        )),
    }
}

/// The members a replica set's `hello` announces, with their role.
pub(super) fn members(hello: &Document) -> Vec<(String, &'static str)> {
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
pub(super) async fn describe(
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
pub(super) fn flavor(build: &Document, hello: &Document) -> Option<String> {
    if build.contains_key("ferretdb") || build.contains_key("ferretdbVersion") {
        return Some("FerretDB".into());
    }
    if hello.contains_key("isCosmos") || build.contains_key("isCosmos") {
        return Some("Azure Cosmos DB".into());
    }
    None
}
