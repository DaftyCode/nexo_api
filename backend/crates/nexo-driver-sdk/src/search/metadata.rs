//! Searching objects by name: the catalog's queries run one after another on the session,
//! their rows turned into hits with their place in the tree.
use super::{ObjectHit, SearchCatalog, SearchParams, SearchResult};
use crate::{Driver, Result, Value, statements::ExecuteParams};

/// The `LIKE` pattern of a name typed with wildcards, in lower case: `*` and `%` for any
/// text, `?` and `_` for one character; without any, the name anywhere (`%name%`).
pub fn name_pattern(text: &str) -> String {
    let pattern: String = text
        .trim()
        .to_lowercase()
        .chars()
        .map(|character| match character {
            '*' => '%',
            '?' => '_',
            other => other,
        })
        .collect();
    if pattern.contains('%') || pattern.contains('_') {
        pattern
    } else {
        format!("%{pattern}%")
    }
}

fn text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::Text(text) | Value::Typed { text, .. } => Some(text.clone()),
        Value::Integer(number) => Some(number.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        _ => None,
    }
}

pub(super) async fn objects<D: Driver + ?Sized>(
    driver: &D,
    params: &SearchParams,
    catalog: &dyn SearchCatalog,
) -> Result<SearchResult> {
    let max = params.max.unwrap_or(super::MAX_HITS).clamp(1, 10_000) as usize;
    let pattern = name_pattern(&params.text);
    let mut result = SearchResult::default();
    for query in catalog.queries(&pattern, params) {
        let left = max + 1 - result.objects.len();
        let answer = driver
            .execute(ExecuteParams {
                connection: params.connection.clone(),
                statement: params.statement.clone(),
                sql: query.sql,
                params: query.params,
                page_rows: Some(left as u32),
                max_rows: Some(left as u64),
            })
            .await?;
        if let Some(cursor) = answer.cursor {
            let close = crate::statements::CursorParams {
                connection: params.connection.clone(),
                cursor,
            };
            let _ = driver.close(close).await;
        }
        for row in answer.rows {
            let schema = text(row.first());
            let table = text(row.get(1));
            let Some(name) = text(row.get(2)) else {
                continue;
            };
            let identity = text(row.get(3));
            let in_code = matches!(row.get(4), Some(Value::Bool(true) | Value::Integer(1)));
            let path = catalog.path(
                query.kind,
                schema.as_deref(),
                table.as_deref(),
                &name,
                identity.as_deref(),
            );
            result.objects.push(ObjectHit {
                kind: query.kind.into(),
                schema,
                table,
                name,
                path,
                in_code,
            });
        }
        if result.objects.len() > max {
            result.objects.truncate(max);
            result.more = true;
            break;
        }
    }
    Ok(result)
}
