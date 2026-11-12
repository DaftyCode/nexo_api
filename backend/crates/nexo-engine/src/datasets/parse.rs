//! Rows from JSON or CSV, with the type of each column inferred.
use super::*;

/// Parses JSON or CSV content (or `rows`) into objects.
pub fn parse_rows(payload: &Value) -> Result<Vec<Map<String, Value>>> {
    let rows = match (&payload["rows"], payload["content"].as_str()) {
        (Value::Array(_), _) => payload["rows"].clone(),
        (_, Some(content)) => {
            let text = content.trim();
            if text.starts_with('[') || text.starts_with('{') {
                serde_json::from_str(text)
                    .map_err(|error| invalid(format!("Invalid JSON dataset: {error}")))?
            } else {
                Value::Array(parse_csv(content)?.into_iter().map(Value::Object).collect())
            }
        }
        _ => Value::Null,
    };
    let Value::Array(rows) = rows else {
        return Err(invalid(
            "Dataset must contain an array with at most 100,000 rows",
        ));
    };
    if rows.len() > MAX_ROWS {
        return Err(invalid(
            "Dataset must contain an array with at most 100,000 rows",
        ));
    }
    rows.into_iter()
        .map(|row| match row {
            Value::Object(object) => Ok(object),
            _ => Err(invalid("Every dataset row must be an object")),
        })
        .collect()
}

/// Numbers are inferred only when converting back gives the same text: `01234` stays text.
pub(super) fn infer(value: &str) -> Value {
    let digits = value.strip_prefix('-').unwrap_or(value);
    let (integer, fraction) = digits
        .split_once('.')
        .map_or((digits, None), |(i, f)| (i, Some(f)));
    let valid = !integer.is_empty()
        && integer.bytes().all(|b| b.is_ascii_digit())
        && (integer == "0" || !integer.starts_with('0'))
        && fraction.is_none_or(|f| !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()));
    if !valid {
        return json!(value);
    }
    if fraction.is_none() {
        return match value.parse::<i64>() {
            Ok(number) if number.unsigned_abs() < (1u64 << 53) && number.to_string() == value => {
                json!(number)
            }
            _ => json!(value),
        };
    }
    match value.parse::<f64>() {
        Ok(number) if number.is_finite() && number.to_string() == value => json!(number),
        _ => json!(value),
    }
}
pub fn parse_csv(text: &str) -> Result<Vec<Map<String, Value>>> {
    let mut records: Vec<Vec<String>> = Vec::new();
    let (mut row, mut field, mut quoted) = (Vec::new(), String::new(), false);
    let mut characters = text.chars().peekable();
    while let Some(c) = characters.next() {
        match c {
            '"' if quoted && characters.peek() == Some(&'"') => {
                field.push('"');
                characters.next();
            }
            '"' => quoted = !quoted,
            ',' if !quoted => row.push(std::mem::take(&mut field)),
            '\n' | '\r' if !quoted => {
                if c == '\r' && characters.peek() == Some(&'\n') {
                    characters.next();
                }
                row.push(std::mem::take(&mut field));
                let record = std::mem::take(&mut row);
                if record.iter().any(|f| !f.is_empty()) {
                    records.push(record);
                }
            }
            _ => field.push(c),
        }
    }
    row.push(field);
    if row.iter().any(|f| !f.is_empty()) {
        records.push(row);
    }
    if quoted {
        return Err(invalid("Unclosed CSV quote"));
    }
    let mut records = records.into_iter();
    let headers: Vec<String> = records
        .next()
        .unwrap_or_default()
        .into_iter()
        .map(|name| name.trim_start_matches('\u{feff}').to_string())
        .collect();
    Ok(records
        .map(|values| {
            headers
                .iter()
                .enumerate()
                .map(|(index, name)| {
                    (
                        name.clone(),
                        infer(values.get(index).map(String::as_str).unwrap_or("")),
                    )
                })
                .collect()
        })
        .collect())
}
