//! Searching the data of tables: one query per table, with a condition per column that can
//! hold what is looked for (its text compared with `LIKE`, lower case; numbers equal), the
//! value bound; then the rows read are checked again for the case and whole words.
use super::{DataHit, SearchCatalog, SearchParams, SearchTable, placeholder, quoted};
use crate::{
    Driver, Result, Value,
    protocol::Dialect,
    statements::{CursorParams, ExecuteParams},
};

/// `%text%` for `LIKE … ESCAPE '!'`: the wildcards and the escape itself taken literally (and
/// `[`, a wildcard of SQL Server).
pub fn like_pattern(text: &str, tsql: bool) -> String {
    let mut pattern = String::from("%");
    for character in text.chars() {
        if matches!(character, '!' | '%' | '_') || (tsql && character == '[') {
            pattern.push('!');
        }
        pattern.push(character);
    }
    pattern.push('%');
    pattern
}

/// Whether `value` holds `needle`, with its case or not, as a whole word or anywhere.
pub fn matches(value: &str, needle: &str, case_sensitive: bool, whole_word: bool) -> bool {
    let (value, needle) = if case_sensitive {
        (value.to_owned(), needle.to_owned())
    } else {
        (value.to_lowercase(), needle.to_lowercase())
    };
    if needle.is_empty() {
        return false;
    }
    if !whole_word {
        return value.contains(&needle);
    }
    let word = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || c == '_');
    value.match_indices(&needle).any(|(at, _)| {
        !word(value[..at].chars().next_back()) && !word(value[at + needle.len()..].chars().next())
    })
}

fn text_of(value: &Value) -> Option<String> {
    match value {
        Value::Text(text) | Value::Typed { text, .. } => Some(text.clone()),
        Value::Integer(number) => Some(number.to_string()),
        Value::Float(number) => Some(number.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        Value::Null | Value::Array(_) => None,
    }
}

async fn execute<D: Driver + ?Sized>(
    driver: &D,
    params: &SearchParams,
    sql: String,
    values: Vec<Value>,
    rows: u32,
) -> Result<crate::statements::ExecuteResult> {
    let answer = driver
        .execute(ExecuteParams {
            connection: params.connection.clone(),
            statement: params.statement.clone(),
            sql,
            params: values,
            page_rows: Some(rows),
            max_rows: Some(u64::from(rows)),
        })
        .await?;
    if let Some(cursor) = &answer.cursor {
        let close = CursorParams {
            connection: params.connection.clone(),
            cursor: cursor.clone(),
        };
        let _ = driver.close(close).await;
    }
    Ok(answer)
}

/// The rows of one table that hold what is looked for, if any.
pub(super) async fn table<D: Driver + ?Sized>(
    driver: &D,
    params: &SearchParams,
    catalog: &dyn SearchCatalog,
    dialect: &Dialect,
    table: &SearchTable,
) -> Result<Option<DataHit>> {
    let name = match &table.schema {
        Some(schema) => format!(
            "{}.{}",
            quoted(dialect, schema),
            quoted(dialect, &table.name)
        ),
        None => quoted(dialect, &table.name),
    };
    let probe = execute(
        driver,
        params,
        format!("SELECT * FROM {name} WHERE 1 = 0"),
        Vec::new(),
        1,
    )
    .await?;
    let looks =
        |class: &str| params.columns.is_empty() || params.columns.iter().any(|c| c == class);
    let number = params
        .text
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|_| looks("number"));
    let mut conditions = Vec::new();
    let mut values = Vec::new();
    // The columns compared, by their place in the row.
    let mut compared = Vec::new();
    for (at, column) in probe.columns.iter().enumerate() {
        let kind = format!("{:?}", column.kind).to_lowercase();
        let quoted_name = quoted(dialect, &column.name);
        if matches!(kind.as_str(), "integer" | "decimal" | "float") {
            // An integer column is only compared with a whole number, bound as one.
            let bound = match number {
                Some(number) if kind != "integer" => Some(Value::Float(number)),
                Some(number) if number.fract() == 0.0 && number.abs() < 9e15 => {
                    Some(Value::Integer(number as i64))
                }
                _ => None,
            };
            if let Some(bound) = bound {
                values.push(bound);
                conditions.push(format!(
                    "{quoted_name} = {}",
                    placeholder(dialect, values.len())
                ));
                compared.push(at);
            }
            continue;
        }
        if !looks("text") {
            continue;
        }
        if let Some(text) = catalog.text_of(&quoted_name, &kind) {
            values.push(Value::Text(like_pattern(
                &params.text.to_lowercase(),
                dialect.name == "tsql",
            )));
            conditions.push(format!(
                "LOWER({text}) LIKE {} ESCAPE '!'",
                placeholder(dialect, values.len())
            ));
            compared.push(at);
        }
    }
    if conditions.is_empty() {
        return Ok(None);
    }
    let rows = params.max_rows.unwrap_or(super::MAX_ROWS).clamp(1, 10_000);
    let sql = format!("SELECT * FROM {name} WHERE {}", conditions.join(" OR "));
    let answer = execute(driver, params, sql, values, rows + 1).await?;
    let mut matched: Vec<String> = Vec::new();
    let mut kept = Vec::new();
    for row in answer.rows {
        let mut found = false;
        for &at in &compared {
            let Some(text) = row.get(at).and_then(text_of) else {
                continue;
            };
            let numeric = number.is_some_and(|number| text.parse::<f64>().ok() == Some(number));
            if numeric
                || matches(
                    &text,
                    &params.text,
                    params.case_sensitive,
                    params.whole_word,
                )
            {
                found = true;
                let name = &probe.columns[at].name;
                if !matched.contains(name) {
                    matched.push(name.clone());
                }
            }
        }
        if found {
            kept.push(row);
        }
    }
    if kept.is_empty() {
        return Ok(None);
    }
    let more = kept.len() > rows as usize;
    kept.truncate(rows as usize);
    Ok(Some(DataHit {
        schema: table.schema.clone(),
        table: table.name.clone(),
        path: table.path.clone(),
        matched,
        columns: probe
            .columns
            .iter()
            .map(|column| column.name.clone())
            .collect(),
        rows: kept,
        more,
    }))
}
