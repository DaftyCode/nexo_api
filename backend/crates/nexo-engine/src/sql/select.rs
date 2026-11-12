//! A `SELECT` as a `find` or a pipeline: joins first, then the filter, the groups and what
//! is kept of them, the order and the page.
use super::filter::condition;
use super::names::{Scope, literal, name, unsupported};
use nexo_domain::Result;
use serde_json::{Map, Value, json};
use sqlparser::ast::{
    Distinct, DuplicateTreatment, Expr, FunctionArg, FunctionArgExpr, FunctionArguments,
    GroupByExpr, LimitClause, OrderBy, OrderByKind, OrderBySort, Select, SelectItem, TableFactor,
};

/// What the query keeps: a column (renamed or not) or an aggregate.
pub(super) enum Output {
    Column {
        field: String,
        name: Option<String>,
    },
    Aggregate {
        name: String,
        text: String,
        accumulator: Value,
    },
}

const AGGREGATES: [&str; 5] = ["COUNT", "SUM", "AVG", "MIN", "MAX"];

/// An aggregate function and the accumulator of `$group` it becomes.
fn aggregate(expr: &Expr, scope: &Scope) -> Result<Option<(String, Value)>> {
    let Expr::Function(function) = expr else {
        return Ok(None);
    };
    let function_name = name(&function.name).to_ascii_uppercase();
    if !AGGREGATES.contains(&function_name.as_str()) {
        return Err(unsupported(format!("the function {}", function.name)));
    }
    let FunctionArguments::List(list) = &function.args else {
        return Err(unsupported(expr));
    };
    if matches!(list.duplicate_treatment, Some(DuplicateTreatment::Distinct)) {
        return Err(unsupported(format!("{function_name}(DISTINCT …)")));
    }
    let argument = match list.args.as_slice() {
        [FunctionArg::Unnamed(FunctionArgExpr::Wildcard)] if function_name == "COUNT" => None,
        [FunctionArg::Unnamed(FunctionArgExpr::Expr(column))] if Scope::is_column(column) => {
            Some(scope.field(column)?)
        }
        _ => return Err(unsupported(format!("{expr}: aggregates take one column"))),
    };
    let lower = function_name.to_ascii_lowercase();
    let default = match &argument {
        Some(field) => format!("{lower}_{}", field.replace('.', "_")),
        None => lower.clone(),
    };
    let accumulator = match (function_name.as_str(), argument) {
        ("COUNT", None) => json!({ "$sum": 1 }),
        ("COUNT", Some(field)) => {
            json!({ "$sum": { "$cond": [{ "$gt": [format!("${field}"), null] }, 1, 0] } })
        }
        (_, Some(field)) => json!({ format!("${lower}"): format!("${field}") }),
        _ => return Err(unsupported(expr)),
    };
    Ok(Some((default, accumulator)))
}

fn count(expr: &Expr, what: &str) -> Result<u64> {
    literal(expr)?
        .as_u64()
        .ok_or_else(|| unsupported(format!("{what} {expr}: it is a whole number")))
}

pub(super) fn translate(
    select: &Select,
    order_by: Option<&OrderBy>,
    limit_clause: Option<&LimitClause>,
) -> Result<Value> {
    if matches!(select.distinct, Some(Distinct::Distinct | Distinct::On(_))) {
        return Err(unsupported("DISTINCT: group by the columns instead"));
    }
    if select.top.is_some()
        || select.into.is_some()
        || select.qualify.is_some()
        || !select.lateral_views.is_empty()
    {
        return Err(unsupported("TOP, INTO, QUALIFY and LATERAL VIEW"));
    }
    let [from] = select.from.as_slice() else {
        return Err(unsupported("a query reads one collection: join the others"));
    };
    let TableFactor::Table {
        name: table, alias, ..
    } = &from.relation
    else {
        return Err(unsupported("FROM reads a collection by its name"));
    };
    let collection = name(table);
    let mut scope = Scope {
        base: vec![collection.clone()],
        joined: Vec::new(),
    };
    if let Some(alias) = alias {
        scope.base.push(alias.name.value.clone());
    }
    let mut stages = super::joins::joins(&from.joins, &mut scope)?;
    let field = |expr: &Expr| scope.field(expr);
    let filter = select
        .selection
        .as_ref()
        .map(|expr| condition(expr, &field))
        .transpose()?;

    let mut outputs = Vec::new();
    let mut star = false;
    for item in &select.projection {
        let (expr, alias) = match item {
            SelectItem::Wildcard(_) => {
                star = true;
                continue;
            }
            SelectItem::UnnamedExpr(expr) => (expr, None),
            SelectItem::ExprWithAlias { expr, alias } => (expr, Some(alias.value.clone())),
            other => return Err(unsupported(format!("the column {other}"))),
        };
        if let Some((default, accumulator)) = aggregate(expr, &scope)? {
            outputs.push(Output::Aggregate {
                name: alias.unwrap_or(default),
                text: expr.to_string().to_ascii_uppercase(),
                accumulator,
            });
        } else if Scope::is_column(expr) {
            outputs.push(Output::Column {
                field: scope.field(expr)?,
                name: alias,
            });
        } else {
            return Err(unsupported(format!(
                "the column {expr}: only columns and COUNT, SUM, AVG, MIN, MAX"
            )));
        }
    }
    let groups = match &select.group_by {
        GroupByExpr::Expressions(exprs, modifiers) if modifiers.is_empty() => exprs.clone(),
        _ => return Err(unsupported("GROUP BY ALL, ROLLUP and CUBE")),
    };
    let grouped = !groups.is_empty()
        || outputs
            .iter()
            .any(|o| matches!(o, Output::Aggregate { .. }));
    let orders: Vec<(&Expr, bool)> = match order_by.map(|order| &order.kind) {
        None => Vec::new(),
        Some(OrderByKind::Expressions(items)) => items
            .iter()
            .map(|item| {
                (
                    &item.expr,
                    matches!(item.options.sort, Some(OrderBySort::Desc)),
                )
            })
            .collect(),
        Some(OrderByKind::All(_)) => return Err(unsupported("ORDER BY ALL")),
    };
    let (skip, limit) = match limit_clause {
        None => (None, None),
        Some(LimitClause::LimitOffset {
            limit,
            offset,
            limit_by,
        }) if limit_by.is_empty() => (
            offset
                .as_ref()
                .map(|o| count(&o.value, "OFFSET"))
                .transpose()?,
            limit.as_ref().map(|l| count(l, "LIMIT")).transpose()?,
        ),
        Some(LimitClause::OffsetCommaLimit { offset, limit }) => {
            (Some(count(offset, "OFFSET")?), Some(count(limit, "LIMIT")?))
        }
        Some(_) => return Err(unsupported("LIMIT BY")),
    };
    if star && (grouped || !outputs.is_empty()) {
        return Err(unsupported("* with other columns or groups"));
    }
    if select.having.is_some() && !grouped {
        return Err(unsupported("HAVING without GROUP BY"));
    }
    let renamed = outputs
        .iter()
        .any(|o| matches!(o, Output::Column { name: Some(n), field } if n != field));
    if grouped {
        return super::select_group::pipeline(
            collection,
            &scope,
            stages,
            filter,
            groups,
            outputs,
            select.having.as_ref(),
            orders,
            skip,
            limit,
        );
    }
    // A column renamed is sorted by what it reads.
    let source = |expr: &Expr| -> Result<String> {
        if let Expr::Identifier(ident) = expr {
            for output in &outputs {
                if let Output::Column {
                    field,
                    name: Some(name),
                } = output
                    && *name == ident.value
                {
                    return Ok(field.clone());
                }
            }
        }
        scope.field(expr)
    };
    let mut sort = Map::new();
    for (expr, descending) in &orders {
        sort.insert(source(expr)?, json!(if *descending { -1 } else { 1 }));
    }
    let mut projection = Map::new();
    if !outputs.is_empty() {
        if !outputs
            .iter()
            .any(|o| matches!(o, Output::Column { field, .. } if field == "_id"))
        {
            projection.insert("_id".into(), json!(0));
        }
        for output in &outputs {
            if let Output::Column { field, name } = output {
                match name {
                    Some(name) if name != field => {
                        projection.insert(name.clone(), json!(format!("${field}")))
                    }
                    _ => projection.insert(field.clone(), json!(1)),
                };
            }
        }
    }
    if stages.is_empty() && !renamed {
        let mut find = json!({ "kind": "find", "collection": collection });
        let fields = [
            ("filter", filter),
            (
                "projection",
                (!projection.is_empty()).then_some(Value::Object(projection)),
            ),
            ("sort", (!sort.is_empty()).then_some(Value::Object(sort))),
        ];
        for (key, value) in fields {
            if let Some(value) = value {
                find[key] = value;
            }
        }
        if let Some(skip) = skip {
            find["skip"] = json!(skip);
        }
        if let Some(limit) = limit {
            find["limit"] = json!(limit);
        }
        return Ok(find);
    }
    if let Some(filter) = filter {
        stages.push(json!({ "$match": filter }));
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
    if !projection.is_empty() {
        stages.push(json!({ "$project": projection }));
    }
    Ok(json!({ "kind": "aggregate", "collection": collection, "pipeline": stages }))
}

pub(super) use Output as SelectOutput;
