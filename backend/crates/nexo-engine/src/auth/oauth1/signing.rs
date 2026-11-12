//! The OAuth 1.0 signature: the base string and HMAC, RSA or plain text signing.
use super::*;

pub(super) fn normalized_url(url: &url::Url) -> String {
    let host = url.host_str().unwrap_or("").to_lowercase();
    let authority = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host,
    };
    let path = if url.path().is_empty() {
        "/"
    } else {
        url.path()
    };
    format!("{}://{authority}{path}", url.scheme().to_lowercase())
}

/// The signature base string (RFC 5849 section 3.4.1).
pub fn base_string(method: &str, url: &url::Url, parameters: &[(String, String)]) -> String {
    let mut all: Vec<(String, String)> = url.query().map(decode_form).unwrap_or_default();
    all.extend(parameters.iter().cloned());
    let mut sortable: Vec<(String, String)> = all
        .iter()
        .filter(|(key, _)| key != "oauth_signature")
        .map(|(key, value)| (percent_encode(key), percent_encode(value)))
        .collect();
    sortable.sort_by(|a, b| format!("{} {}", a.0, a.1).cmp(&format!("{} {}", b.0, b.1)));
    let normalized = sortable
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("&");
    format!(
        "{}&{}&{}",
        percent_encode(&method.to_uppercase()),
        percent_encode(&normalized_url(url)),
        percent_encode(&normalized)
    )
}

pub(super) fn rsa_sign(private_key: &str, hash: &str, message: &[u8]) -> Result<Vec<u8>> {
    let key = PrivateKeyDer::from_pem_slice(private_key.as_bytes())
        .map_err(|_| invalid("The private key must be an RSA key in PEM format"))?;
    let der = key.secret_der();
    if hash == "SHA1" {
        return rsa_sha1(der, message);
    }
    let pair = match &key {
        PrivateKeyDer::Pkcs8(_) => signature::RsaKeyPair::from_pkcs8(der),
        _ => signature::RsaKeyPair::from_der(der),
    }
    .map_err(|_| invalid("The private key is not a valid RSA key"))?;
    let encoding: &'static dyn signature::RsaEncoding = match hash {
        "SHA256" => &signature::RSA_PKCS1_SHA256,
        "SHA512" => &signature::RSA_PKCS1_SHA512,
        other => return Err(invalid(format!("Unsupported RSA hash: {other}"))),
    };
    let mut output = vec![0; pair.public_modulus_len()];
    pair.sign(encoding, &SystemRandom::new(), message, &mut output)
        .map_err(|_| invalid("Could not sign with the RSA key"))?;
    Ok(output)
}

/// RSA PKCS#1 v1.5 with SHA-1, which aws-lc-rs only offers for verifying: signed with the
/// AWS-LC library underneath it.
pub(super) fn rsa_sha1(der: &[u8], message: &[u8]) -> Result<Vec<u8>> {
    use aws_lc_sys as ffi;
    let failed = || invalid("Could not sign with the RSA key (RSA-SHA1)");
    let length = std::os::raw::c_long::try_from(der.len()).map_err(|_| failed())?;
    // SAFETY: every pointer comes from AWS-LC and is checked for null before use; the key
    // and context are freed on every path; `der` and `message` outlive the calls, and the
    // output buffer has the size AWS-LC reports.
    unsafe {
        let mut input = der.as_ptr();
        let key = ffi::d2i_AutoPrivateKey(std::ptr::null_mut(), &mut input, length);
        if key.is_null() {
            return Err(invalid("The private key is not a valid RSA key"));
        }
        let context = ffi::EVP_MD_CTX_new();
        let result = (|| {
            if context.is_null()
                || ffi::EVP_DigestSignInit(
                    context,
                    std::ptr::null_mut(),
                    ffi::EVP_sha1(),
                    std::ptr::null_mut(),
                    key,
                ) != 1
            {
                return Err(failed());
            }
            let mut size = 0usize;
            if ffi::EVP_DigestSign(
                context,
                std::ptr::null_mut(),
                &mut size,
                message.as_ptr(),
                message.len(),
            ) != 1
            {
                return Err(failed());
            }
            let mut output = vec![0u8; size];
            if ffi::EVP_DigestSign(
                context,
                output.as_mut_ptr(),
                &mut size,
                message.as_ptr(),
                message.len(),
            ) != 1
            {
                return Err(failed());
            }
            output.truncate(size);
            Ok(output)
        })();
        if !context.is_null() {
            ffi::EVP_MD_CTX_free(context);
        }
        ffi::EVP_PKEY_free(key);
        result
    }
}

/// The `oauth_signature` value for a base string.
pub fn signature(
    method: &str,
    base: &str,
    consumer_secret: &str,
    token_secret: &str,
    private_key: &str,
) -> Result<String> {
    let key = format!(
        "{}&{}",
        percent_encode(consumer_secret),
        percent_encode(token_secret)
    );
    let hmac = |algorithm| {
        STANDARD.encode(hmac::sign(
            &hmac::Key::new(algorithm, key.as_bytes()),
            base.as_bytes(),
        ))
    };
    Ok(match method {
        "PLAINTEXT" => key.clone(),
        "HMAC-SHA1" => hmac(hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY),
        "HMAC-SHA256" => hmac(hmac::HMAC_SHA256),
        "HMAC-SHA512" => hmac(hmac::HMAC_SHA512),
        "RSA-SHA1" | "RSA-SHA256" | "RSA-SHA512" => STANDARD.encode(rsa_sign(
            private_key,
            &method[4..].replace('-', ""),
            base.as_bytes(),
        )?),
        other => {
            return Err(invalid(format!(
                "Unsupported OAuth 1.0 signature method: {other}"
            )));
        }
    })
}
