//! A `SELECT` with `GROUP BY` or aggregates as a pipeline: `$group` by the columns, the
//! aggregates as accumulators, then what the query keeps named as it names them, so `HAVING`
//! and `ORDER BY` read those names.
use super::filter::condition;
use super::names::{Scope, unsupported};
use super::select::SelectOutput as Output;
use nexo_domain::Result;
use serde_json::{Map, Value, json};
use sqlparser::ast::Expr;

#[allow(clippy::too_many_arguments)]
pub(super) fn pipeline(
    collection: String,
    scope: &Scope,
    mut stages: Vec<Value>,
    filter: Option<Value>,
    groups: Vec<Expr>,
    outputs: Vec<Output>,
    having: Option<&Expr>,
    orders: Vec<(&Expr, bool)>,
    skip: Option<u64>,
    limit: Option<u64>,
) -> Result<Value> {
    if let Some(filter) = filter {
        stages.push(json!({ "$match": filter }));
    }
    // Each grouped column: the name it is kept as, and the field it reads.
    let mut keys: Vec<(String, String)> = Vec::new();
    for group in &groups {
        if !Scope::is_column(group) {
            return Err(unsupported(format!("GROUP BY {group}: group by columns")));
        }
        let field = scope.field(group)?;
        let alias = outputs.iter().find_map(|output| match output {
            Output::Column {
                field: kept,
                name: Some(name),
            } if *kept == field => Some(name.clone()),
            _ => None,
        });
        keys.push((alias.unwrap_or_else(|| field.replace('.', "_")), field));
    }
    let mut group = Map::new();
    group.insert(
        "_id".into(),
        if keys.is_empty() {
            Value::Null
        } else {
            Value::Object(
                keys.iter()
                    .map(|(key, field)| (key.clone(), json!(format!("${field}"))))
                    .collect(),
            )
        },
    );
    let mut project = Map::new();
    project.insert("_id".into(), json!(0));
    for output in &outputs {
        match output {
            Output::Aggregate {
                name, accumulator, ..
            } => {
                group.insert(name.clone(), accumulator.clone());
                project.insert(name.clone(), json!(1));
            }
            Output::Column { field, .. } => {
                let (key, _) = keys
                    .iter()
                    .find(|(_, grouped)| grouped == field)
                    .ok_or_else(|| {
                        unsupported(format!(
                            "{field} is neither in GROUP BY nor in an aggregate"
                        ))
                    })?;
                project.insert(key.clone(), json!(format!("$_id.{key}")));
            }
        }
    }
    stages.push(json!({ "$group": group }));
    stages.push(json!({ "$project": project }));
    // HAVING and ORDER BY name what the query keeps.
    let kept = |expr: &Expr| -> Result<String> {
        let text = expr.to_string().to_ascii_uppercase();
        for output in &outputs {
            match output {
                Output::Aggregate {
                    name,
                    text: written,
                    ..
                } if *written == text || name.to_ascii_uppercase() == text => {
                    return Ok(name.clone());
                }
                Output::Column {
                    name: Some(name), ..
                } if name.to_ascii_uppercase() == text => return Ok(name.clone()),
                _ => {}
            }
        }
        if Scope::is_column(expr) {
            let field = scope.field(expr)?;
            let selected = outputs.iter().any(
                |output| matches!(output, Output::Column { field: kept, .. } if *kept == field),
            );
            if let Some((key, _)) = keys
                .iter()
                .find(|(_, grouped)| *grouped == field)
                .filter(|_| selected)
            {
                return Ok(key.clone());
            }
        }
        Err(unsupported(format!(
            "{expr}: add it to the SELECT to filter or sort by it"
        )))
    };
    if let Some(having) = having {
        stages.push(json!({ "$match": condition(having, &kept)? }));
    }
    let mut sort = Map::new();
    for (expr, descending) in orders {
        sort.insert(kept(expr)?, json!(if descending { -1 } else { 1 }));
    }
    if !sort.is_empty() {
        stages.push(json!({ "$sort": sort }));
    }
    if let Some(skip) = skip {
        stages.push(json!({ "$skip": skip }));
    }
    if let Some(limit) = limit {
        stages.push(json!({ "$limit": limit }));
    }
    Ok(json!({ "kind": "aggregate", "collection": collection, "pipeline": stages }))
}
