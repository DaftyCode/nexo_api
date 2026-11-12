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
        let mut proxied = None;
        let proxy = &settings["proxy"];
        if proxy.is_object() && proxy["disabled"] != true {
            let uri = proxy["uri"].as_str().map(String::from).unwrap_or_else(|| {
                format!(
                    "{}://{}:{}",
                    proxy["protocol"].as_str().unwrap_or("http"),
                    proxy["host"].as_str().unwrap_or(""),
                    string(proxy.get("port"))
                )
            });
            let mut configured = reqwest::Proxy::all(&uri)
                .map_err(|error| Error::Validation(format!("Invalid proxy: {error}")))?;
            if let Some(user) = proxy["username"].as_str() {
                configured = configured.basic_auth(user, proxy["password"].as_str().unwrap_or(""));
            }
            builder = builder.proxy(configured);
            proxied = Some(uri);
        } else {
            builder = builder.no_proxy();
        }
        Ok(Self {
            client: builder
                .build()
                .map_err(|error| Error::Infrastructure(error.to_string()))?,
            options,
            jar,
            proxied,
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
