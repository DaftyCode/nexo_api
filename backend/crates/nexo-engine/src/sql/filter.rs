//! `WHERE` and `HAVING` as a MongoDB filter: comparisons, `AND`, `OR`, `NOT`, `IN`, `LIKE`,
//! `IS NULL` and `BETWEEN`; two columns compared become an `$expr`.
use super::names::{is_literal, like, literal, unsupported};
use nexo_domain::Result;
use serde_json::{Map, Value, json};
use sqlparser::ast::{BinaryOperator, Expr, InTarget, UnaryOperator};

/// Names a column or an aggregate of the condition as a field.
pub(super) type Field<'a> = &'a dyn Fn(&Expr) -> Result<String>;

fn comparison(op: &BinaryOperator) -> Option<&'static str> {
    Some(match op {
        BinaryOperator::Eq => "$eq",
        BinaryOperator::NotEq => "$ne",
        BinaryOperator::Lt => "$lt",
        BinaryOperator::LtEq => "$lte",
        BinaryOperator::Gt => "$gt",
        BinaryOperator::GtEq => "$gte",
        _ => return None,
    })
}

/// The same comparison with its sides swapped (`5 < a` is `a > 5`).
fn flipped(operator: &'static str) -> &'static str {
    match operator {
        "$lt" => "$gt",
        "$lte" => "$gte",
        "$gt" => "$lt",
        "$gte" => "$lte",
        other => other,
    }
}

fn single(field: String, value: Value) -> Value {
    let mut document = Map::new();
    document.insert(field, value);
    Value::Object(document)
}

/// Joins conditions with `$and` or `$or`, flattening nested ones of the same kind.
fn joined(operator: &str, left: Value, right: Value) -> Value {
    let mut items = Vec::new();
    for side in [left, right] {
        match side {
            Value::Object(mut document)
                if document.len() == 1 && document.contains_key(operator) =>
            {
                if let Some(Value::Array(inner)) = document.remove(operator) {
                    items.extend(inner);
                }
            }
            other => items.push(other),
        }
    }
    json!({ operator: items })
}

pub(super) fn condition(expr: &Expr, field: Field) -> Result<Value> {
    match expr {
        Expr::Nested(inner) => condition(inner, field),
        Expr::BinaryOp {
            left,
            op: BinaryOperator::And,
            right,
        } => Ok(joined(
            "$and",
            condition(left, field)?,
            condition(right, field)?,
        )),
        Expr::BinaryOp {
            left,
            op: BinaryOperator::Or,
            right,
        } => Ok(joined(
            "$or",
            condition(left, field)?,
            condition(right, field)?,
        )),
        Expr::BinaryOp { left, op, right } => {
            let operator =
                comparison(op).ok_or_else(|| unsupported(format!("the operator {op}")))?;
            match (is_literal(left), is_literal(right)) {
                (false, true) => compare(field(left)?, operator, literal(right)?),
                (true, false) => compare(field(right)?, flipped(operator), literal(left)?),
                (false, false) => Ok(json!({ "$expr": {
                    operator: [format!("${}", field(left)?), format!("${}", field(right)?)]
                }})),
                (true, true) => Err(unsupported(format!("{expr} compares two values"))),
            }
        }
        Expr::UnaryOp {
            op: UnaryOperator::Not,
            expr,
        } => Ok(json!({ "$nor": [condition(expr, field)?] })),
        Expr::IsNull(inner) => Ok(single(field(inner)?, Value::Null)),
        Expr::IsNotNull(inner) => Ok(single(field(inner)?, json!({ "$ne": null }))),
        Expr::IsTrue(inner) => Ok(single(field(inner)?, json!(true))),
        Expr::IsFalse(inner) => Ok(single(field(inner)?, json!(false))),
        Expr::In {
            expr: inner,
            target: InTarget::List(items),
            negated,
            ..
        } => {
            let values = items.iter().map(literal).collect::<Result<Vec<_>>>()?;
            let operator = if *negated { "$nin" } else { "$in" };
            Ok(single(field(inner)?, json!({ operator: values })))
        }
        Expr::Between {
            expr: inner,
            negated,
            low,
            high,
        } => {
            let name = field(inner)?;
            let (low, high) = (literal(low)?, literal(high)?);
            Ok(if *negated {
                json!({ "$or": [single(name.clone(), json!({"$lt": low})), single(name, json!({"$gt": high}))] })
            } else {
                single(name, json!({ "$gte": low, "$lte": high }))
            })
        }
        Expr::Like {
            negated,
            any: false,
            expr: inner,
            pattern,
            escape_char: None,
        }
        | Expr::ILike {
            negated,
            any: false,
            expr: inner,
            pattern,
            escape_char: None,
        } => {
            let Value::String(text) = literal(pattern)? else {
                return Err(unsupported(format!("{pattern} is not a LIKE pattern")));
            };
            let mut regex = json!({ "$regex": like(&text) });
            if matches!(expr, Expr::ILike { .. }) {
                regex["$options"] = json!("i");
            }
            Ok(single(
                field(inner)?,
                if *negated {
                    json!({ "$not": regex })
                } else {
                    regex
                },
            ))
        }
        Expr::Identifier(_) | Expr::CompoundIdentifier(_) => Ok(single(field(expr)?, json!(true))),
        other => Err(unsupported(format!("the condition {other}"))),
    }
}

fn compare(field: String, operator: &str, value: Value) -> Result<Value> {
    Ok(match (operator, &value) {
        ("$eq", _) => single(field, value),
        _ => single(field, json!({ operator: value })),
    })
}
