//! The HTTP client of a transport (TLS, proxy and the guarded resolver), and streamed posts.
use super::*;

impl Transport {
    pub fn new(options: Options, jar: CookieJar) -> Result<Self> {
        let settings = &options.transport;
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .danger_accept_invalid_certs(!options.strict_ssl)
            .timeout(options.timeout)
            .dns_resolver(Arc::new(GuardedResolver {
                policy: options.egress.clone(),
                loopback_ports: options.loopback_ports.clone(),
            }));
        if let Some(pem) = settings["caPem"].as_str().filter(|p| !p.trim().is_empty()) {
            for certificate in reqwest::Certificate::from_pem_bundle(pem.as_bytes())
                .map_err(|error| Error::Validation(format!("Invalid CA certificate: {error}")))?
            {
                builder = builder.add_root_certificate(certificate);
            }
        }
        if let (Some(cert), Some(key)) = (
            settings["clientTls"]["certPem"].as_str(),
            settings["clientTls"]["keyPem"].as_str(),
        ) {
            let identity = reqwest::Identity::from_pem(format!("{cert}\n{key}").as_bytes())
                .map_err(|error| {
                    Error::Validation(format!("Invalid client certificate: {error}"))
                })?;
            builder = builder.identity(identity);
        }
        // The route of the settings: directly, or through an HTTP or SOCKS5 proxy.
        let route = crate::route::Route::from_settings(settings)?;
        match route.proxy_url() {
            Some(url) => {
                let mut configured = reqwest::Proxy::all(&url)
                    .map_err(|error| Error::Validation(format!("Invalid proxy: {error}")))?;
                if let Some(credentials) = route.credentials() {
                    configured =
                        configured.basic_auth(&credentials.username, &credentials.password);
                }
                builder = builder.proxy(configured);
            }
            None => builder = builder.no_proxy(),
        }
        let dialer = crate::route::Dialer::new(
            route,
            options.egress.clone(),
            options.loopback_ports.clone(),
        );
        Ok(Self {
            client: builder
                .build()
                .map_err(|error| Error::Infrastructure(error.to_string()))?,
            options,
            jar,
            dialer,
        })
    }

    /// Posts a JSON `body` and returns the response as it arrives, for streams such as
    /// server-sent events. Its egress, TLS and proxy settings are this transport's.
    pub async fn stream(
        &self,
        url: &Url,
        headers: &[(String, String)],
        body: String,
    ) -> Result<reqwest::Response> {
        let mut request = self
            .client
            .post(url.clone())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .body(body);
        for (key, value) in headers {
            request = request.header(key.as_str(), value.as_str());
        }
        request.send().await.map_err(request_error)
    }
}
