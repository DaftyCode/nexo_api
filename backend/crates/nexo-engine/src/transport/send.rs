//! Sending a request: signing it, each hop checked against the egress policy and the hosts
//! its secrets allow, authentication challenges, redirects and the response.
use super::*;

/// What one hop of a request sends.
struct HopRequest<'a> {
    method: &'a str,
    url: &'a Url,
    same_origin: bool,
    headers: &'a HeaderList,
    body: Option<&'a Vec<u8>>,
    credential_headers: &'a [String],
}

impl Transport {
    /// Sends a collection-format request (`url`, `method`, `header`, `auth`, `body`).
    /// `secrets` are the restricted vault secrets it carries: no hop, redirects included,
    /// takes one to a host it does not allow.
    pub async fn request(
        &self,
        input: &Value,
        secrets: &[crate::secret_hosts::Placement],
    ) -> Result<Value> {
        let started = Instant::now();
        let mut url = parse_url(&request_url(&input["url"]))?;
        let mut method = crate::collection::http_method(input["method"].as_str().unwrap_or("GET"))?;
        let mut headers = request_headers(&input["header"]);
        let mut credential_headers: Vec<String> = SENSITIVE.iter().map(|s| s.to_string()).collect();
        let mut auth = auth_values(&input["auth"]);
        let mut warnings = Vec::new();
        let mut body = request_body(&method, &input["body"], &mut headers, &mut warnings)?;
        // Signed once the request is built: Digest `auth-int` and the signature types read
        // the final method, URL, headers and body.
        let had_body = body.is_some();
        let mut signed_body = body.take().unwrap_or_default();
        crate::auth::sign(
            &auth,
            &mut crate::auth::Outgoing {
                method: &method,
                url: &mut url,
                headers: &mut headers,
                body: &mut signed_body,
                credential_headers: &mut credential_headers,
            },
        )?;
        // OAuth 1.0 may have added its parameters to a form body.
        if had_body || !signed_body.is_empty() {
            body = Some(signed_body.clone());
        }
        let origin = url.origin();
        // Challenges answered: Digest answers one, NTLM two (negotiate, then authenticate).
        let mut challenges_answered = 0;
        let mut redirects = 0;
        let response = loop {
            let response = self
                .send_hop(
                    &HopRequest {
                        method: &method,
                        url: &url,
                        same_origin: url.origin() == origin,
                        headers: &headers,
                        body: body.as_ref(),
                        credential_headers: &credential_headers,
                    },
                    secrets,
                )
                .await?;
            let status = response.status().as_u16();
            if (status == 401 || status == 403) && challenges_answered < 2 && url.origin() == origin
            {
                let challenges: Vec<String> = response
                    .headers()
                    .get_all(reqwest::header::WWW_AUTHENTICATE)
                    .iter()
                    .filter_map(|v| v.to_str().ok())
                    .map(String::from)
                    .collect();
                let answered = crate::auth::answer_challenge(
                    &mut auth,
                    challenges_answered,
                    status,
                    &challenges,
                    &mut crate::auth::Outgoing {
                        method: &method,
                        url: &mut url,
                        headers: &mut headers,
                        body: &mut signed_body,
                        credential_headers: &mut credential_headers,
                    },
                )?;
                if answered {
                    challenges_answered += 1;
                    // Read the body to the end so the connection is reused: NTLM authenticates
                    // the connection, not each request.
                    let _ = response.bytes().await;
                    continue;
                }
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .map(String::from);
            if ![301, 302, 303, 307, 308].contains(&status)
                || location.is_none()
                || !self.options.follow_redirects
            {
                break response;
            }
            redirects += 1;
            if redirects > 20 {
                return Err(Error::Validation("Maximum redirect count exceeded".into()));
            }
            url = url
                .join(&location.unwrap_or_default())
                .map_err(|_| Error::Validation("Invalid redirect location".into()))?;
            if !["http", "https"].contains(&url.scheme()) {
                return Err(Error::Validation(format!(
                    "Unsupported URL protocol {}:",
                    url.scheme()
                )));
            }
            if (status == 303 && method != "HEAD")
                || ([301, 302].contains(&status) && method == "POST")
            {
                method = "GET".into();
                body = None;
                headers.delete("content-type");
                headers.delete("content-length");
            }
        };
        self.read_response(response, &url, &method, started, warnings)
            .await
    }

    /// Sends one hop: its destination (or the proxy) passes the egress policy and the hosts
    /// its secrets allow, credential headers stay on the request's own origin unless
    /// redirects are trusted, and the jar's cookies go along and are updated.
    async fn send_hop(
        &self,
        hop: &HopRequest<'_>,
        secrets: &[crate::secret_hosts::Placement],
    ) -> Result<reqwest::Response> {
        let url = hop.url;
        let host = url.host_str().unwrap_or("").to_string();
        let port = url.port_or_known_default().unwrap_or(80);
        match &self.proxied {
            Some(proxy) => {
                let proxy_url = parse_url(proxy)?;
                self.options
                    .egress
                    .resolve(
                        proxy_url.host_str().unwrap_or(""),
                        proxy_url.port_or_known_default().unwrap_or(80),
                        &self.options.loopback_ports,
                    )
                    .await?;
            }
            None => {
                self.options
                    .egress
                    .resolve(&host, port, &self.options.loopback_ports)
                    .await?;
            }
        }
        crate::secret_hosts::check_hop(
            secrets,
            &crate::secret_hosts::Hop {
                host: &host,
                same_origin: hop.same_origin,
                body: hop.body.is_some(),
                credential_headers: hop.credential_headers,
                trust_redirect_credentials: self.options.trust_redirect_credentials,
            },
        )?;
        let mut headers = hop.headers.clone();
        if !hop.same_origin && !self.options.trust_redirect_credentials {
            for name in hop.credential_headers {
                headers.delete(name);
            }
        }
        if !headers.has("cookie") {
            let cookie = {
                let jar = self.jar.lock().unwrap_or_else(|e| e.into_inner());
                jar.get_request_values(url)
                    .map(|(name, value)| format!("{name}={value}"))
                    .collect::<Vec<_>>()
                    .join("; ")
            };
            if !cookie.is_empty() {
                headers.set("cookie", &cookie);
            }
        }
        let mut request = self.client.request(
            Method::from_bytes(hop.method.as_bytes())
                .map_err(|_| Error::Validation("Invalid HTTP method".into()))?,
            url.clone(),
        );
        for (name, value) in &headers.0 {
            let name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| Error::Validation(format!("Invalid header name: {name}")))?;
            let value = HeaderValue::from_str(value)
                .map_err(|_| Error::Validation(format!("Invalid value for header {name}")))?;
            request = request.header(name, value);
        }
        if let Some(data) = hop.body {
            request = request.body(data.clone());
        }
        let response = request.send().await.map_err(request_error)?;
        {
            let mut jar = self.jar.lock().unwrap_or_else(|e| e.into_inner());
            let cookies = response
                .headers()
                .get_all(reqwest::header::SET_COOKIE)
                .iter()
                .filter_map(|v| v.to_str().ok())
                .filter_map(|v| RawCookie::parse(v.to_string()).ok());
            jar.store_response_cookies(cookies, url);
        }
        Ok(response)
    }

    /// The response as Nexo reports it: status, headers, the body up to `MAX_BODY` decoded
    /// by its charset, the cookies for its URL and the time taken.
    async fn read_response(
        &self,
        mut response: reqwest::Response,
        url: &Url,
        method: &str,
        started: Instant,
        warnings: Vec<String>,
    ) -> Result<Value> {
        let status = response.status();
        let response_headers: Vec<Value> = response
            .headers()
            .iter()
            .map(|(k, v)| json!({"key": k.as_str(), "value": v.to_str().unwrap_or_default()}))
            .collect();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let declared = response.content_length();
        let mut bytes = Vec::new();
        let mut size = 0usize;
        let mut truncated = false;
        while let Some(chunk) = response.chunk().await.map_err(request_error)? {
            size += chunk.len();
            if size > MAX_BODY {
                truncated = true;
                break;
            }
            bytes.extend_from_slice(&chunk);
        }
        let (text, encoding) = decode_body(&bytes, &content_type);
        let cookies: Vec<Value> = {
            let jar = self.jar.lock().unwrap_or_else(|e| e.into_inner());
            jar.matches(url)
                .into_iter()
                .map(|cookie| json!({"key": cookie.name(), "value": cookie.value(), "domain": cookie.domain(), "path": cookie.path()}))
                .collect()
        };
        let mut result = json!({
            "url": url.as_str(),
            "method": method,
            "status": status.as_u16(),
            "statusText": status.canonical_reason().unwrap_or(""),
            "headers": response_headers,
            "body": text,
            "size": if truncated { declared.map(|d| d as usize).unwrap_or(size).max(size) } else { size },
            "time": started.elapsed().as_millis() as u64,
            "cookies": cookies,
        });
        if let Some(encoding) = encoding {
            result["bodyEncoding"] = json!(encoding);
        }
        if truncated {
            result["truncated"] = json!(true);
        }
        if !warnings.is_empty() {
            result["warnings"] = json!(warnings);
        }
        Ok(result)
    }
}
