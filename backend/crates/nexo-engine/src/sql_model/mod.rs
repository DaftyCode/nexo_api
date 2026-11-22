//! `db.query.parse` (DB-26): a `SELECT` read into the model of the visual query builder
//! (tables, joins, columns, conditions, groups, order and page), or the construction that the
//! model cannot hold (subqueries, `UNION`, `WITH`, window functions…). The builder never
//! rewrites SQL that the model does not represent whole, so anything it cannot read back
//! exactly is refused by name rather than approximated. Expressions travel as SQL text, as
//! the parser writes them.
mod condition;
mod from;
#[cfg(test)]
mod tests;

use nexo_domain::{Error, Result};
use serde_json::{Value, json};
use sqlparser::{
    ast::{
        Distinct, DuplicateTreatment, Expr, FunctionArg, FunctionArgExpr, FunctionArguments,
        GroupByExpr, LimitClause, ObjectNamePart, OrderByKind, OrderBySort, Query, Select,
        SelectItem, SetExpr, Statement, TopQuantity,
    },
    dialect::{
        Dialect, GenericDialect, MsSqlDialect, MySqlDialect, PostgreSqlDialect, SQLiteDialect,
    },
    parser::Parser,
};

/// Characters of SQL read at most: the parser recurses into nested expressions.
const MAX_SQL: usize = 20_000;

/// Why the model cannot hold a statement: it is said, not an error of the request.
struct Unsupported(String);
type Read<T> = std::result::Result<T, Unsupported>;
fn unsupported<T>(what: impl Into<String>) -> Read<T> {
    Err(Unsupported(what.into()))
}

fn dialect(name: &str) -> Box<dyn Dialect> {
    match name {
        "postgresql" | "postgres" => Box::new(PostgreSqlDialect {}),
        "mysql" | "mariadb" => Box::new(MySqlDialect {}),
        "tsql" | "mssql" | "sqlserver" => Box::new(MsSqlDialect {}),
        "sqlite" => Box::new(SQLiteDialect {}),
        _ => Box::new(GenericDialect {}),
    }
}

/// `{model}` of one `SELECT`, or `{unsupported}` with what it has that the model has not.
pub fn parse(sql: &str, dialect_name: &str) -> Result<Value> {
    if sql.len() > MAX_SQL {
        return Err(Error::Validation(format!(
            "The SQL is longer than {MAX_SQL} characters"
        )));
    }
    let statements = Parser::parse_sql(dialect(dialect_name).as_ref(), sql)
        .map_err(|error| Error::Validation(format!("The SQL cannot be read: {error}")))?;
    let answer = match statements.as_slice() {
        [Statement::Query(query)] => query_model(query),
        [_] => unsupported("statements other than SELECT"),
        _ => unsupported("more than one statement"),
    };
    Ok(match answer {
        Ok(model) => json!({ "model": model }),
        Err(Unsupported(what)) => json!({ "unsupported": what }),
    })
}

/// `db.query.parse`: the SQL and the dialect of its payload.
pub fn parse_payload(payload: &Value) -> Result<Value> {
    parse(
        payload["sql"].as_str().unwrap_or_default(),
        payload["dialect"].as_str().unwrap_or_default(),
    )
}

/// SQL text with a subquery or a window function, which the model cannot hold.
fn plain(text: String) -> Read<String> {
    let upper = text.to_ascii_uppercase();
    let word = |word: &str| {
        upper
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            .any(|part| part == word)
    };
    if word("SELECT") {
        return unsupported("subqueries");
    }
    if word("OVER") {
        return unsupported("window functions");
    }
    Ok(text)
}
fn expression(expr: &Expr) -> Read<String> {
    plain(expr.to_string())
}

fn whole(expr: &Expr, what: &str) -> Read<u64> {
    expr.to_string()
        .parse()
        .or_else(|_| unsupported(format!("{what} that is not a number")))
}

fn query_model(query: &Query) -> Read<Value> {
    if query.with.is_some() {
        return unsupported("WITH");
    }
    if !query.locks.is_empty() || query.for_clause.is_some() || query.settings.is_some() {
        return unsupported("FOR UPDATE and other clauses");
    }
    let SetExpr::Select(select) = query.body.as_ref() else {
        return unsupported("UNION, INTERSECT, EXCEPT and VALUES");
    };
    let mut model = select_model(select)?;
    let mut order = Vec::new();
    if let Some(order_by) = &query.order_by {
        let OrderByKind::Expressions(items) = &order_by.kind else {
            return unsupported("ORDER BY ALL");
        };
        for item in items {
            if item.options.nulls_first.is_some() || item.with_fill.is_some() {
                return unsupported("NULLS FIRST and NULLS LAST");
            }
            let descending = match item.options.sort {
                None | Some(OrderBySort::Asc) => false,
                Some(OrderBySort::Desc) => true,
                Some(_) => return unsupported("ORDER BY … USING"),
            };
            order.push(json!({"expression": expression(&item.expr)?, "descending": descending}));
        }
    }
    model["orderBy"] = Value::Array(order);
    match &query.limit_clause {
        None => {}
        Some(LimitClause::LimitOffset {
            limit,
            offset,
            limit_by,
        }) if limit_by.is_empty() => {
            if let Some(limit) = limit {
                model["limit"] = json!(whole(limit, "a LIMIT")?);
            }
            if let Some(offset) = offset {
                model["offset"] = json!(whole(&offset.value, "an OFFSET")?);
            }
        }
        Some(LimitClause::OffsetCommaLimit { offset, limit }) => {
            model["limit"] = json!(whole(limit, "a LIMIT")?);
            model["offset"] = json!(whole(offset, "an OFFSET")?);
        }
        Some(_) => return unsupported("LIMIT BY"),
    }
    if let Some(fetch) = &query.fetch {
        let Some(quantity) = fetch
            .quantity
            .as_ref()
            .filter(|_| !fetch.with_ties && !fetch.percent)
        else {
            return unsupported("FETCH with ties or a percent");
        };
        model["limit"] = json!(whole(quantity, "a FETCH")?);
    }
    Ok(model)
}

/// An aggregate the model knows, with what it applies to (`*` for `COUNT(*)`).
fn aggregate(expr: &Expr) -> Read<Option<(&'static str, String)>> {
    let Expr::Function(function) = expr else {
        return Ok(None);
    };
    let [ObjectNamePart::Identifier(name)] = function.name.0.as_slice() else {
        return Ok(None);
    };
    let name = match name.value.to_ascii_lowercase().as_str() {
        "count" => "count",
        "sum" => "sum",
        "avg" => "avg",
        "min" => "min",
        "max" => "max",
        _ => return Ok(None),
    };
    let FunctionArguments::List(list) = &function.args else {
        return Ok(None);
    };
    if function.over.is_some()
        || function.filter.is_some()
        || function.null_treatment.is_some()
        || !function.within_group.is_empty()
        || !list.clauses.is_empty()
    {
        return unsupported("window functions");
    }
    let distinct = matches!(list.duplicate_treatment, Some(DuplicateTreatment::Distinct));
    let argument = match list.args.as_slice() {
        [FunctionArg::Unnamed(FunctionArgExpr::Wildcard)] if name == "count" && !distinct => {
            "*".to_string()
        }
        [FunctionArg::Unnamed(FunctionArgExpr::Expr(argument))] => expression(argument)?,
        _ => return Ok(None),
    };
    Ok(Some(match (name, distinct) {
        ("count", true) => ("count-distinct", argument),
        (_, true) => return Ok(None),
        (name, false) => (name, argument),
    }))
}

fn column(expr: &Expr, alias: &str) -> Read<Value> {
    if let Some((aggregate, argument)) = aggregate(expr)? {
        return Ok(json!({"expression": argument, "alias": alias, "aggregate": aggregate}));
    }
    Ok(json!({"expression": expression(expr)?, "alias": alias, "aggregate": ""}))
}

fn select_model(select: &Select) -> Read<Value> {
    let distinct = match &select.distinct {
        None | Some(Distinct::All) => false,
        Some(Distinct::Distinct) => true,
        Some(_) => return unsupported("DISTINCT ON"),
    };
    if select.into.is_some()
        || select.qualify.is_some()
        || select.prewhere.is_some()
        || !select.lateral_views.is_empty()
        || !select.named_window.is_empty()
        || !select.connect_by.is_empty()
        || !select.cluster_by.is_empty()
        || !select.distribute_by.is_empty()
        || !select.sort_by.is_empty()
        || select.exclude.is_some()
        || select.select_modifiers.is_some()
        || !select.optimizer_hints.is_empty()
    {
        return unsupported("INTO, QUALIFY, WINDOW and other clauses");
    }
    let (tables, joins) = from::tables(&select.from)?;
    let mut columns = Vec::new();
    for item in &select.projection {
        columns.push(match item {
            SelectItem::UnnamedExpr(expr) => column(expr, "")?,
            SelectItem::ExprWithAlias { expr, alias } => column(expr, &alias.value)?,
            SelectItem::Wildcard(_) | SelectItem::QualifiedWildcard(..) => {
                json!({"expression": plain(item.to_string())?, "alias": "", "aggregate": ""})
            }
            _ => return unsupported("a column with several aliases"),
        });
    }
    let group_by = match &select.group_by {
        GroupByExpr::Expressions(items, modifiers) if modifiers.is_empty() => {
            items.iter().map(expression).collect::<Read<Vec<_>>>()?
        }
        _ => return unsupported("GROUP BY ALL, ROLLUP and CUBE"),
    };
    let mut model = json!({
        "distinct": distinct,
        "tables": tables,
        "joins": joins,
        "columns": columns,
        "where": select.selection.as_ref().map(condition::group).transpose()?,
        "groupBy": group_by,
        "having": select.having.as_ref().map(condition::group).transpose()?,
        "limit": null,
        "offset": null,
    });
    if let Some(top) = &select.top {
        let quantity = match &top.quantity {
            Some(TopQuantity::Constant(quantity)) if !top.percent && !top.with_ties => *quantity,
            Some(TopQuantity::Expr(expr)) if !top.percent && !top.with_ties => {
                whole(expr, "a TOP")?
            }
            _ => return unsupported("TOP with a percent or ties"),
        };
        model["limit"] = json!(quantity);
    }
    Ok(model)
}
