//! Opening a connection: every server checked with the host before the library connects to
//! it, and the description of what was opened.
use super::*;
use mongodb::options::Socks5Proxy;

impl MongoDriver {
    /// Why Nexo may not reach a server, if it may not, as the host answers: a secret of the
    /// connection that is not allowed there, or the egress policy (for a server behind a
    /// proxy or a tunnel, as the far side resolves it).
    pub(super) async fn refusal(
        link: &HostLink,
        connection: &DatabaseConnection,
        host: &str,
        port: u16,
    ) -> Option<String> {
        link.check(&connection.name, host, port)
            .await
            .err()
            .map(|error| error.message)
    }

    /// Checks every server of a connection with the host, and opens it, through its proxy
    /// when its route has one.
    pub(super) async fn connect_to(
        &self,
        link: &HostLink,
        connection: &DatabaseConnection,
    ) -> Result<Opened> {
        let (mut options, files) = connection::options(connection, &self.tls_directory).await?;
        options.socks5_proxy = connection.proxy.clone().map(|proxy| {
            let credentials = proxy
                .user
                .map(|user| (user, proxy.password.unwrap_or_default()));
            Socks5Proxy::builder()
                .host(proxy.host)
                .port(proxy.port)
                .authentication(credentials)
                .build()
        });
        let seeds: Vec<(String, u16)> = options.hosts.iter().map(address).collect::<Result<_>>()?;
        let mut refusals: HashMap<String, Option<String>> = HashMap::new();
        for (host, port) in &seeds {
            if let Some(reason) = Self::refusal(link, connection, host, *port).await {
                return Err(Error::Validation(format!(
                    "Nexo may not connect to {host}:{port}: {reason}"
                )));
            }
            refusals.insert(format!("{host}:{port}"), None);
        }

        // The library connects to every server a replica set announces, and nothing can
        // filter them. When some destinations may be refused (by the policy or a secret's
        // allowed domains), the first server is asked for them first, connected to directly.
        let mut direct = false;
        let client = if connection.check_members
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
                let reason = Self::refusal(link, connection, &host, port).await;
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

    /// What the connection found: version, topology and each server with whether Nexo may
    /// reach it.
    pub(super) async fn report(&self, link: &HostLink, name: &str) -> Result<ConnectionReport> {
        let open = self.open(name)?;
        let mut refusals = open.refusals.lock().await;
        describe(
            link,
            &open.client,
            (&open.options, &open.connection),
            &open.seeds,
            open.direct,
            &mut refusals,
        )
        .await
    }
}
