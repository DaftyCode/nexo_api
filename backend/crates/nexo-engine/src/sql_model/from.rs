//! The tables of a `SELECT`: the first one of `FROM` and those it joins, each by its name
//! (its parts, unquoted) and alias; a join is its kind and the comparisons of two columns its
//! `ON` asks for, all of them (`AND`).
use super::{Read, expression, unsupported};
use serde_json::{Value, json};
use sqlparser::ast::{
    BinaryOperator, Expr, JoinConstraint, JoinOperator, ObjectNamePart, TableFactor, TableWithJoins,
};

fn table(factor: &TableFactor) -> Read<Value> {
    let TableFactor::Table {
        name,
        alias,
        args,
        with_hints,
        version,
        partitions,
        sample,
        index_directives,
        ..
    } = factor
    else {
        return unsupported("subqueries and table functions in FROM");
    };
    if args.is_some()
        || !with_hints.is_empty()
        || version.is_some()
        || !partitions.is_empty()
        || sample.is_some()
        || !index_directives.is_empty()
    {
        return unsupported("table hints, functions and partitions");
    }
    let mut path = Vec::new();
    for part in &name.0 {
        let ObjectNamePart::Identifier(ident) = part else {
            return unsupported("a table named by a function");
        };
        path.push(ident.value.clone());
    }
    let alias = match alias {
        None => String::new(),
        Some(alias) if alias.columns.is_empty() => alias.name.value.clone(),
        Some(_) => return unsupported("an alias that renames columns"),
    };
    Ok(json!({"path": path, "alias": alias}))
}

const COMPARISONS: [(BinaryOperator, &str); 6] = [
    (BinaryOperator::Eq, "="),
    (BinaryOperator::NotEq, "<>"),
    (BinaryOperator::Lt, "<"),
    (BinaryOperator::LtEq, "<="),
    (BinaryOperator::Gt, ">"),
    (BinaryOperator::GtEq, ">="),
];

/// The comparisons of an `ON`: `a.x = b.y AND …`.
fn comparisons(expr: &Expr, found: &mut Vec<Value>) -> Read<()> {
    match expr {
        Expr::Nested(inner) => comparisons(inner, found),
        Expr::BinaryOp {
            left,
            op: BinaryOperator::And,
            right,
        } => {
            comparisons(left, found)?;
            comparisons(right, found)
        }
        Expr::BinaryOp { left, op, right } => {
            let Some((_, operator)) = COMPARISONS.iter().find(|(known, _)| known == op) else {
                return unsupported(format!("the join condition {expr}"));
            };
            found.push(json!({
                "left": expression(left)?,
                "operator": operator,
                "right": expression(right)?,
            }));
            Ok(())
        }
        _ => unsupported(format!("the join condition {expr}")),
    }
}

/// The tables and the joins between them, from `FROM`.
pub(super) fn tables(from: &[TableWithJoins]) -> Read<(Vec<Value>, Vec<Value>)> {
    let [first] = from else {
        return if from.is_empty() {
            unsupported("a SELECT without FROM")
        } else {
            unsupported("tables separated by commas: join them")
        };
    };
    let mut tables = vec![table(&first.relation)?];
    let mut joins = Vec::new();
    for join in &first.joins {
        let (kind, constraint) = match &join.join_operator {
            JoinOperator::Join(c) | JoinOperator::Inner(c) => ("inner", c),
            JoinOperator::Left(c) | JoinOperator::LeftOuter(c) => ("left", c),
            JoinOperator::Right(c) | JoinOperator::RightOuter(c) => ("right", c),
            JoinOperator::FullOuter(c) => ("full", c),
            _ => return unsupported("CROSS, APPLY, NATURAL and other joins"),
        };
        let JoinConstraint::On(on) = constraint else {
            return unsupported("JOIN … USING and joins without ON");
        };
        let mut found = Vec::new();
        comparisons(on, &mut found)?;
        tables.push(table(&join.relation)?);
        joins.push(json!({"table": tables.len() - 1, "kind": kind, "on": found}));
    }
    Ok((tables, joins))
}
