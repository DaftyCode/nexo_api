//! SQL read as MongoDB: a `SELECT` of one collection, with `WHERE`, `ORDER BY`, `LIMIT` and
//! `OFFSET`, becomes a `find`; with aliases, `GROUP BY` (`COUNT`, `SUM`, `AVG`, `MIN`,
//! `MAX`), `HAVING` or `INNER`/`LEFT JOIN` by equality it becomes an aggregation pipeline.
//! What is not supported is refused and named, never translated approximately. Only reads:
//! the interface shows the query it gives, editable, and runs it as its own.
mod filter;
mod joins;
mod names;
mod select;
mod select_group;
#[cfg(test)]
mod tests;

use names::unsupported;
use nexo_domain::{Error, Result};
use serde_json::Value;
use sqlparser::{
    ast::{SetExpr, Statement},
    dialect::GenericDialect,
    parser::Parser,
};

/// Characters of SQL read at most: the parser recurses into nested expressions.
const MAX_SQL: usize = 20_000;

/// The MongoDB query a SQL `SELECT` stands for: `{kind: "find", collection, filter, …}` or
/// `{kind: "aggregate", collection, pipeline}`, in relaxed Extended JSON.
pub fn translate(sql: &str) -> Result<Value> {
    if sql.len() > MAX_SQL {
        return Err(Error::Validation(format!(
            "The SQL is longer than {MAX_SQL} characters"
        )));
    }
    let mut statements = Parser::parse_sql(&GenericDialect {}, sql)
        .map_err(|error| Error::Validation(format!("The SQL cannot be read: {error}")))?;
    if statements.len() != 1 {
        return Err(Error::Validation("Write one SELECT".into()));
    }
    let Statement::Query(query) = statements.remove(0) else {
        return Err(Error::Validation(
            "Only SELECT is supported: Nexo translates SQL that reads".into(),
        ));
    };
    if query.with.is_some() {
        return Err(unsupported("WITH"));
    }
    let SetExpr::Select(select) = query.body.as_ref() else {
        return Err(unsupported("UNION, INTERSECT, EXCEPT and VALUES"));
    };
    select::translate(select, query.order_by.as_ref(), query.limit_clause.as_ref())
}
