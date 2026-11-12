//! Request bodies by mode, and response bodies decoded by their charset.
use super::*;

/// Decodes text with its declared charset; binary payloads are returned as base64.
pub fn decode_body(bytes: &[u8], content_type: &str) -> (String, Option<&'static str>) {
    let kind = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let textual = kind.starts_with("text/")
        || kind.contains("json")
        || kind.contains("xml")
        || kind.contains("javascript")
        || kind.contains("x-www-form-urlencoded")
        || kind.contains("graphql");
    let binary = !textual
        && (kind.starts_with("image/")
            || kind.starts_with("audio/")
            || kind.starts_with("video/")
            || kind.starts_with("font/")
            || [
                "application/octet-stream",
                "application/pdf",
                "application/zip",
                "application/gzip",
            ]
            .contains(&kind.as_str())
            || bytes[..bytes.len().min(4096)].contains(&0));
    if binary {
        return (STANDARD.encode(bytes), Some("base64"));
    }
    let charset = content_type
        .split(';')
        .filter_map(|part| part.trim().strip_prefix("charset="))
        .next()
        .map(|c| c.trim_matches('"').to_lowercase());
    if let Some(charset) = charset.filter(|c| c != "utf-8" && c != "utf8")
        && let Some(encoding) = encoding_rs::Encoding::for_label(charset.as_bytes())
    {
        return (encoding.decode(bytes).0.into_owned(), None);
    }
    (String::from_utf8_lossy(bytes).into_owned(), None)
}

/// A `multipart/form-data` body. Text rows are sent as text, with their `contentType` when
/// they have one; file rows send the files chosen for them, with their name and type, and a
/// file row whose file was not chosen fails, as a file cannot be read from its path.
pub(super) fn multipart(rows: &[Value]) -> Result<(String, Vec<u8>)> {
    let boundary = format!("----nexo{}", uuid::Uuid::new_v4().simple());
    // As browsers do: quotes encoded and line breaks removed from names.
    let escape = |value: &str| value.replace('"', "%22").replace(['\r', '\n'], " ");
    let header = |value: &str| value.replace(['\r', '\n'], " ");
    let mut body = Vec::new();
    for row in rows.iter().filter(|row| row["disabled"] != true) {
        let name = escape(&string(row.get("key")));
        if crate::files::is_file(row) {
            let sources = crate::files::sources(&row["src"]);
            let parts = crate::files::attached(row)?;
            if parts.len() < sources.len() {
                let missing = &sources[parts.len()];
                return Err(Error::Validation(format!(
                    "Choose the file {missing} for the form-data field {}",
                    string(row.get("key"))
                )));
            }
            for part in parts {
                body.extend_from_slice(
                    format!(
                        "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{}\"\r\nContent-Type: {}\r\n\r\n",
                        escape(&part.name),
                        header(&part.content_type)
                    )
                    .as_bytes(),
                );
                body.extend_from_slice(&part.bytes);
                body.extend_from_slice(b"\r\n");
            }
            continue;
        }
        let content_type = row["contentType"]
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .map(|value| format!("Content-Type: {}\r\n", header(value)))
            .unwrap_or_default();
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n{content_type}\r\n{}\r\n",
                string(row.get("value"))
            )
            .as_bytes(),
        );
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    Ok((format!("multipart/form-data; boundary={boundary}"), body))
}

/// The enabled headers of a request, from rows or an object.
pub(super) fn request_headers(input: &Value) -> HeaderList {
    let mut headers = HeaderList::default();
    let header_rows: Vec<(String, String)> = match input {
        Value::Array(rows) => rows
            .iter()
            .filter(|h| h["disabled"] != true && h["enabled"] != false)
            .filter_map(|h| {
                h["key"]
                    .as_str()
                    .filter(|k| !k.is_empty())
                    .map(|k| (k.to_string(), string(h.get("value"))))
            })
            .collect(),
        Value::Object(map) => map
            .iter()
            .map(|(k, v)| (k.clone(), string(Some(v))))
            .collect(),
        _ => vec![],
    };
    for (key, value) in header_rows {
        headers.append(&key, &value);
    }
    headers
}

/// The body of a request by its mode (URL-encoded, form data, a file, GraphQL or raw), with
/// the content type it implies unless one was set. GET and HEAD are sent without a body.
pub(super) fn request_body(
    method: &str,
    body_input: &Value,
    headers: &mut HeaderList,
    warnings: &mut Vec<String>,
) -> Result<Option<Vec<u8>>> {
    let mut body: Option<Vec<u8>> = None;
    let has_body = match body_input {
        Value::Object(b) => {
            b.get("mode").and_then(Value::as_str) != Some("raw") || !string(b.get("raw")).is_empty()
        }
        Value::String(text) => !text.is_empty(),
        _ => false,
    };
    if method == "GET" || method == "HEAD" {
        if has_body {
            warnings.push(format!("{method} requests are sent without a body"));
        }
        return Ok(None);
    }
    match body_input["mode"].as_str() {
        Some("urlencoded") => {
            let mut serializer = url::form_urlencoded::Serializer::new(String::new());
            for row in body_input["urlencoded"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|r| r["disabled"] != true)
            {
                serializer.append_pair(&string(row.get("key")), &string(row.get("value")));
            }
            body = Some(serializer.finish().into_bytes());
            if !headers.has("content-type") {
                headers.set("content-type", "application/x-www-form-urlencoded");
            }
        }
        Some("formdata") => {
            let rows = body_input["formdata"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let (content_type, data) = multipart(&rows)?;
            headers.set("content-type", &content_type);
            body = Some(data);
        }
        // Postman's "binary": the bytes of one file, as chosen.
        Some("file") => {
            let file = &body_input["file"];
            let src = file["src"].as_str().unwrap_or_default();
            match crate::files::attached(file)?.into_iter().next() {
                Some(part) => {
                    if !headers.has("content-type") {
                        headers.set("content-type", &part.content_type);
                    }
                    body = Some(part.bytes);
                }
                None if !src.trim().is_empty() => {
                    return Err(Error::Validation(format!(
                        "Choose the file {src} to send as the body"
                    )));
                }
                None => {}
            }
        }
        Some("graphql") => {
            let variables_text = body_input["graphql"]["variables"].as_str().unwrap_or("{}");
            let variables: Value = serde_json::from_str(if variables_text.trim().is_empty() {
                "{}"
            } else {
                variables_text
            })
            .map_err(|error| {
                Error::Validation(format!("GraphQL variables must be valid JSON: {error}"))
            })?;
            body = Some(json!({"query": body_input["graphql"]["query"].as_str().unwrap_or(""), "variables": variables}).to_string().into_bytes());
            if !headers.has("content-type") {
                headers.set("content-type", "application/json");
            }
        }
        _ => {
            let raw = match body_input {
                Value::String(text) => text.clone(),
                _ => string(body_input.get("raw")),
            };
            if !raw.is_empty() {
                if body_input["options"]["raw"]["language"] == "json"
                    && !headers.has("content-type")
                {
                    headers.set("content-type", "application/json");
                }
                body = Some(raw.into_bytes());
            }
        }
    }
    Ok(body)
}
