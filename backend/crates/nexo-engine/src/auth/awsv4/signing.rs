//! Signing a request at a given time: the canonical request, the string to sign and the
//! signature, in headers or in the query.
use super::*;

pub(super) fn sign_at(credentials: &Credentials, request: &mut Outgoing, datetime: &str) {
    let s3 = credentials.service == "s3";
    for name in [
        "Authorization",
        "X-Amz-Date",
        "X-Amz-Security-Token",
        "X-Amz-Content-Sha256",
    ] {
        request.headers.delete(name);
    }
    let kept: Vec<(String, String)> = request
        .url
        .query_pairs()
        .filter(|(key, _)| !SIGNATURE_PARAMETERS.contains(&key.as_ref()))
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    let raw_query: Vec<String> = request
        .url
        .query()
        .unwrap_or("")
        .split('&')
        .filter(|pair| {
            let key = pair.split('=').next().unwrap_or("");
            !pair.is_empty() && !SIGNATURE_PARAMETERS.contains(&key)
        })
        .map(str::to_string)
        .collect();

    let scope = format!(
        "{}/{}/{}/aws4_request",
        &datetime[..8],
        credentials.region,
        credentials.service
    );
    let mut added: Vec<(String, String)> = Vec::new();
    if credentials.to_query {
        if !credentials.session_token.is_empty() {
            added.push((
                "X-Amz-Security-Token".into(),
                credentials.session_token.clone(),
            ));
        }
        if s3 && !kept.iter().any(|(key, _)| key == "X-Amz-Expires") {
            added.push(("X-Amz-Expires".into(), "86400".into()));
        }
        added.push(("X-Amz-Date".into(), datetime.into()));
        added.push(("X-Amz-Algorithm".into(), "AWS4-HMAC-SHA256".into()));
        added.push((
            "X-Amz-Credential".into(),
            format!("{}/{scope}", credentials.access_key),
        ));
    } else {
        if !credentials.session_token.is_empty() {
            request
                .headers
                .set("X-Amz-Security-Token", &credentials.session_token);
            request
                .credential_headers
                .push("X-Amz-Security-Token".into());
        }
        if !request.body.is_empty() || s3 {
            request
                .headers
                .set("X-Amz-Content-Sha256", &sha256_hex(request.body));
        }
        request.headers.set("X-Amz-Date", datetime);
    }

    // Signed headers: every header but those clients change, plus Host, sorted by name.
    let mut headers: Vec<(String, String)> = Vec::new();
    for (name, value) in request.headers.iter() {
        let name = name.to_ascii_lowercase();
        if UNSIGNED.contains(&name.as_str()) {
            continue;
        }
        let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
        match headers.iter_mut().find(|(known, _)| *known == name) {
            Some((_, values)) => {
                values.push(',');
                values.push_str(&value);
            }
            None => headers.push((name, value)),
        }
    }
    if !headers.iter().any(|(name, _)| name == "host") {
        let host = request.url.host_str().unwrap_or("").to_string();
        let host = match request.url.port() {
            Some(port) => format!("{host}:{port}"),
            None => host,
        };
        headers.push(("host".into(), host));
    }
    headers.sort_by(|a, b| a.0.cmp(&b.0));
    let signed_headers = headers
        .iter()
        .map(|(name, _)| name.as_str())
        .collect::<Vec<_>>()
        .join(";");
    if credentials.to_query {
        added.push(("X-Amz-SignedHeaders".into(), signed_headers.clone()));
    }

    let payload = if s3 && credentials.to_query {
        "UNSIGNED-PAYLOAD".to_string()
    } else {
        request
            .headers
            .get("x-amz-content-sha256")
            .first()
            .map(|hash| hash.to_string())
            .unwrap_or_else(|| sha256_hex(request.body))
    };
    let mut parameters = kept.clone();
    parameters.extend(added.iter().cloned());
    let canonical = [
        request.method.to_string(),
        canonical_path(request.url.path(), s3),
        canonical_query(&parameters, s3),
        headers
            .iter()
            .map(|(name, value)| format!("{name}:{value}\n"))
            .collect(),
        signed_headers.clone(),
        payload,
    ]
    .join("\n");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{datetime}\n{scope}\n{}",
        sha256_hex(canonical.as_bytes())
    );
    let mut key = format!("AWS4{}", credentials.secret_key).into_bytes();
    for part in [
        &datetime[..8],
        credentials.region.as_str(),
        credentials.service.as_str(),
        "aws4_request",
    ] {
        key = hmac_sha256(&key, part);
    }
    let signature = hex::encode(hmac_sha256(&key, &string_to_sign));

    if credentials.to_query {
        added.push(("X-Amz-Signature".into(), signature));
        let mut query = raw_query;
        query.extend(
            added
                .iter()
                .filter(|(key, _)| !kept.iter().any(|(known, _)| known == key))
                .map(|(key, value)| format!("{}={}", percent_encode(key), percent_encode(value))),
        );
        request.url.set_query(Some(&query.join("&")));
    } else {
        request.headers.set(
            "Authorization",
            &format!(
                "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
                credentials.access_key
            ),
        );
        request.credential_headers.push("Authorization".into());
    }
}
