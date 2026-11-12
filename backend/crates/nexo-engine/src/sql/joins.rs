//! `INNER JOIN` and `LEFT JOIN` by the equality of two columns, as `$lookup` and `$unwind`:
//! the joined collection's document lives under its alias.
use super::names::{Scope, name, unsupported};
use nexo_domain::Result;
use serde_json::{Value, json};
use sqlparser::ast::{BinaryOperator, Expr, Join, JoinConstraint, JoinOperator, TableFactor};

pub(super) fn joins(joins: &[Join], scope: &mut Scope) -> Result<Vec<Value>> {
    let mut stages = Vec::new();
    for join in joins {
        let TableFactor::Table {
            name: joined,
            alias,
            ..
        } = &join.relation
        else {
            return Err(unsupported("JOIN reads a collection by its name"));
        };
        let (constraint, left) = match &join.join_operator {
            JoinOperator::Join(c) | JoinOperator::Inner(c) => (c, false),
            JoinOperator::Left(c) | JoinOperator::LeftOuter(c) => (c, true),
            other => {
                return Err(unsupported(
                    format!("{other:?} JOIN: only INNER and LEFT").replace("(On(", "(…"),
                ));
            }
        };
        let from_name = name(joined);
        let as_name = alias
            .as_ref()
            .map(|a| a.name.value.clone())
            .unwrap_or_else(|| from_name.clone());
        let JoinConstraint::On(Expr::BinaryOp {
            left: a,
            op: BinaryOperator::Eq,
            right: b,
        }) = constraint
        else {
            return Err(unsupported("a JOIN is ON one equality of two columns"));
        };
        let own = |expr: &Expr| match expr {
            Expr::CompoundIdentifier(parts) if parts.len() > 1 && parts[0].value == as_name => {
                Some(
                    parts[1..]
                        .iter()
                        .map(|p| p.value.clone())
                        .collect::<Vec<_>>()
                        .join("."),
                )
            }
            _ => None,
        };
        let (local, foreign) = match (own(a), own(b)) {
            (Some(foreign), None) => (scope.field(b)?, foreign),
            (None, Some(foreign)) => (scope.field(a)?, foreign),
            _ => {
                return Err(unsupported(
                    format!("the JOIN condition {constraint:?}")
                        .chars()
                        .take(120)
                        .collect::<String>(),
                ));
            }
        };
        stages.push(json!({"$lookup": {"from": from_name, "localField": local, "foreignField": foreign, "as": as_name}}));
        stages.push(
            json!({"$unwind": {"path": format!("${as_name}"), "preserveNullAndEmptyArrays": left}}),
        );
        scope.joined.push(as_name);
    }
    Ok(stages)
}
