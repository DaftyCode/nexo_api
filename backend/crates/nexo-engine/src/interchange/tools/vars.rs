//! Variables in each tool's syntax written as Nexo's `{{name}}`.
use super::Report;
use serde_json::Value;

/// Whether a variable name is plain: letters, digits and `_ - . $`.
fn plain(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | '$'))
}

/// Each `{{ … }}` of a text written again by `rewrite`, which returns `None` to keep it.
fn each_braced(text: &str, rewrite: impl Fn(&str) -> Option<String>) -> String {
    let mut output = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        let Some(end) = rest[start + 2..].find("}}") else {
            break;
        };
        let inner = &rest[start + 2..start + 2 + end];
        output.push_str(&rest[..start]);
        match rewrite(inner.trim()) {
            Some(written) => output.push_str(&written),
            None => output.push_str(&rest[start..start + end + 4]),
        }
        rest = &rest[start + end + 4..];
    }
    output.push_str(rest);
    output
}

/// Insomnia's Nunjucks variables (`{{ _.name }}`, `{{ name }}`, `{{ _['name'] }}`). Its
/// template tags (`{% response … %}`, `{% faker … %}`) have no equivalent: they stay as
/// they are, with a note.
pub(crate) fn insomnia(text: &str, item: &str, report: &mut Report) -> String {
    if text.contains("{%") {
        report.note("templateTag", item);
    }
    each_braced(text, |inner| {
        let name = inner
            .strip_prefix("_.")
            .or_else(|| {
                inner
                    .strip_prefix("_['")
                    .and_then(|rest| rest.strip_suffix("']"))
            })
            .or_else(|| {
                inner
                    .strip_prefix("_[\"")
                    .and_then(|rest| rest.strip_suffix("\"]"))
            })
            .unwrap_or(inner);
        plain(name).then(|| format!("{{{{{name}}}}}"))
    })
}

/// Hoppscotch's `<<name>>`.
pub(crate) fn hoppscotch(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<<") {
        let Some(end) = rest[start + 2..].find(">>") else {
            break;
        };
        let name = rest[start + 2..start + 2 + end].trim();
        output.push_str(&rest[..start]);
        if plain(name) {
            output.push_str(&format!("{{{{{name}}}}}"));
        } else {
            output.push_str(&rest[start..start + end + 4]);
        }
        rest = &rest[start + end + 4..];
    }
    output.push_str(rest);
    output
}

/// Thunder Client's system variables (`{{#guid}}`) that Postman has too (`{{$guid}}`).
pub(crate) fn thunder(text: &str) -> String {
    each_braced(text, |inner| {
        let dynamic = match inner.strip_prefix('#')? {
            "guid" => "$guid",
            "timestamp" => "$timestamp",
            "dateISO" => "$isoTimestamp",
            "email" => "$randomEmail",
            "number" => "$randomInt",
            "bool" => "$randomBoolean",
            "string" => "$randomAlphaNumeric",
            _ => return None,
        };
        Some(format!("{{{{{dynamic}}}}}"))
    })
}

/// A Thunder Client path parameter (`/users/{id}`) as Postman's (`/users/:id`); variables
/// (`{{name}}`) stay as they are.
pub(crate) fn thunder_path(url: &str) -> String {
    let mut output = String::with_capacity(url.len());
    let mut chars = url.char_indices().peekable();
    while let Some((at, c)) = chars.next() {
        let doubled = url[at..].starts_with("{{");
        let single = c == '{' && !doubled && (at == 0 || !url[..at].ends_with('{'));
        if single && let Some(end) = url[at + 1..].find('}') {
            let name = &url[at + 1..at + 1 + end];
            if plain(name) && !name.contains('$') {
                output.push(':');
                output.push_str(name);
                while chars.peek().is_some_and(|(next, _)| *next <= at + 1 + end) {
                    chars.next();
                }
                continue;
            }
        }
        output.push(c);
    }
    output
}

/// Every text inside a JSON value written again by `rewrite`: the settings of an
/// authorization.
pub(crate) fn each_text(value: &Value, rewrite: &mut impl FnMut(&str) -> String) -> Value {
    match value {
        Value::String(text) => Value::String(rewrite(text)),
        Value::Array(items) => items.iter().map(|item| each_text(item, rewrite)).collect(),
        Value::Object(map) => map
            .iter()
            .map(|(key, inner)| (key.clone(), each_text(inner, rewrite)))
            .collect(),
        other => other.clone(),
    }
}
