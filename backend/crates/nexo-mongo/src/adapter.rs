//! Opening and keeping connections: the client for a connection, refused destinations and
//! the connection test.
use super::*;

impl MongoAdapter {
    /// An open connection for this one, opened (and every server checked) when there is
    /// none. Connections unused for a while are closed.
    pub(super) async fn client(
        &self,
        connection: &DatabaseConnection,
    ) -> Result<(Client, Option<String>)> {
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
    pub(super) async fn refusal(
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

    pub(super) async fn run_test(
        &self,
        connection: DatabaseConnection,
    ) -> Result<ConnectionReport> {
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
    pub(super) async fn connect(&self, connection: &DatabaseConnection) -> Result<Opened> {
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
