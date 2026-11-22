//! `WHERE` and `HAVING` as groups of conditions: «all» (`AND`) or «any» (`OR`) of conditions
//! and other groups. A condition is an expression (a column, or an aggregate in `HAVING`), an
//! operator and its values; a value is text (a string literal, unescaped), a number or an
//! expression written as SQL. `NOT`, `EXISTS` and the rest are refused.
use super::{Read, expression, unsupported};
use serde_json::{Value, json};
use sqlparser::ast::{BinaryOperator, Expr, InTarget, UnaryOperator, Value as Literal};

fn value(expr: &Expr) -> Read<Value> {
    Ok(match expr {
        Expr::Value(value) => match &value.value {
            Literal::SingleQuotedString(text) | Literal::NationalStringLiteral(text) => {
                json!({"text": text, "kind": "text"})
            }
            Literal::Number(number, false) => json!({"text": number, "kind": "number"}),
            _ => json!({"text": expression(expr)?, "kind": "expression"}),
        },
        Expr::UnaryOp {
            op: UnaryOperator::Minus,
            expr: inner,
        } if matches!(inner.as_ref(), Expr::Value(v) if matches!(v.value, Literal::Number(..))) => {
            json!({"text": format!("-{inner}"), "kind": "number"})
        }
        _ => json!({"text": expression(expr)?, "kind": "expression"}),
    })
}

fn condition(column: &Expr, operator: &str, values: &[&Expr]) -> Read<Value> {
    Ok(json!({
        "column": expression(column)?,
        "operator": operator,
        "values": values.iter().map(|v| value(v)).collect::<Read<Vec<_>>>()?,
    }))
}

const COMPARISONS: [(BinaryOperator, &str); 6] = [
    (BinaryOperator::Eq, "="),
    (BinaryOperator::NotEq, "<>"),
    (BinaryOperator::Lt, "<"),
    (BinaryOperator::LtEq, "<="),
    (BinaryOperator::Gt, ">"),
    (BinaryOperator::GtEq, ">="),
];

/// One item of a group: a condition, or a group of its own in parentheses.
fn item(expr: &Expr) -> Read<Value> {
    match expr {
        Expr::Nested(inner) => item(inner),
        Expr::BinaryOp {
            op: BinaryOperator::And | BinaryOperator::Or,
            ..
        } => group(expr),
        Expr::BinaryOp { left, op, right } => {
            let Some((_, operator)) = COMPARISONS.iter().find(|(known, _)| known == op) else {
                return unsupported(format!("the condition {expr}"));
            };
            condition(left, operator, &[right])
        }
        Expr::Like {
            negated,
            any: false,
            expr: column,
            pattern,
            escape_char: None,
        } => condition(
            column,
            if *negated { "not like" } else { "like" },
            &[pattern],
        ),
        Expr::In {
            expr: column,
            target: InTarget::List(list),
            negated,
            ..
        } => {
            let values: Vec<&Expr> = list.iter().collect();
            condition(column, if *negated { "not in" } else { "in" }, &values)
        }
        Expr::Between {
            expr: column,
            negated,
            low,
            high,
        } => condition(
            column,
            if *negated { "not between" } else { "between" },
            &[low, high],
        ),
        Expr::IsNull(column) => condition(column, "is null", &[]),
        Expr::IsNotNull(column) => condition(column, "is not null", &[]),
        _ => {
            // A subquery is said as such, wherever it is.
            expression(expr)?;
            unsupported(format!("the condition {expr}"))
        }
    }
}

/// The items joined by one operator, flattened while it is the same one.
fn collect(expr: &Expr, operator: &BinaryOperator, items: &mut Vec<Value>) -> Read<()> {
    match expr {
        Expr::BinaryOp { left, op, right } if op == operator => {
            collect(left, operator, items)?;
            collect(right, operator, items)
        }
        _ => {
            items.push(item(expr)?);
            Ok(())
        }
    }
}

/// A whole `WHERE` or `HAVING`, or a part of it in parentheses.
pub(super) fn group(expr: &Expr) -> Read<Value> {
    let expr = match expr {
        Expr::Nested(inner) => inner.as_ref(),
        other => other,
    };
    let (operator, any) = match expr {
        Expr::BinaryOp {
            op: BinaryOperator::Or,
            ..
        } => (BinaryOperator::Or, true),
        _ => (BinaryOperator::And, false),
    };
    let mut items = Vec::new();
    collect(expr, &operator, &mut items)?;
    Ok(json!({"match": if any { "any" } else { "all" }, "items": items}))
}
