//! The canonical path and query of a request, encoded as AWS expects.
use super::*;

/// The path as `aws4` signs it: services other than S3 collapse repeated slashes, resolve `.`
/// and `..` and encode the (already encoded) segments again; S3 encodes them once.
pub(super) fn canonical_path(path: &str, s3: bool) -> String {
    if path == "/" || path.is_empty() {
        return "/".into();
    }
    let mut path = path.to_string();
    if !s3 {
        while path.contains("//") {
            path = path.replace("//", "/");
        }
    }
    let mut segments: Vec<String> = Vec::new();
    for piece in path.split('/') {
        if !s3 && piece == ".." {
            segments.pop();
        } else if s3 || piece != "." {
            let piece = if s3 {
                percent_decode(&piece.replace('+', " "))
            } else {
                piece.to_string()
            };
            segments.push(percent_encode(&piece));
        }
    }
    let mut path = segments.join("/");
    if !path.starts_with('/') {
        path.insert(0, '/');
    }
    if s3 {
        path = path.replace("%2F", "/");
    }
    path
}

pub(super) fn percent_decode(text: &str) -> String {
    url::form_urlencoded::parse(format!("x={}", text.replace('&', "%26")).as_bytes())
        .next()
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default()
}

/// Parameters encoded and sorted by name, then by value; S3 signs only the first value of a
/// repeated name.
pub(super) fn canonical_query(parameters: &[(String, String)], s3: bool) -> String {
    let mut names: Vec<(String, Vec<String>)> = Vec::new();
    for (key, value) in parameters {
        if key.is_empty() {
            continue;
        }
        let key = percent_encode(key);
        let value = percent_encode(value);
        match names.iter_mut().find(|(known, _)| *known == key) {
            Some((_, values)) if !s3 => values.push(value),
            Some(_) => {}
            None => names.push((key, vec![value])),
        }
    }
    names.sort_by(|a, b| a.0.cmp(&b.0));
    names
        .into_iter()
        .flat_map(|(key, mut values)| {
            values.sort();
            values
                .into_iter()
                .map(move |value| format!("{key}={value}"))
        })
        .collect::<Vec<_>>()
        .join("&")
}
