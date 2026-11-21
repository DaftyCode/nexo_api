//! Column types of two engines side by side: the same type, an equivalent one (what Nexo
//! makes of the type when it copies a table to the other engine, or a type of the same
//! kind), or a different one.
use super::super::{Dialect, SourceColumn, convert};
use serde::Serialize;

/// How two things of the two sides stand.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Equal,
    /// Not written alike, but the same for the other engine.
    Equivalent,
    Different,
    OnlySource,
    OnlyTarget,
}

/// A type as Nexo compares it: lower case, spaces collapsed, without `unsigned` noise.
fn written(type_name: &str) -> String {
    type_name
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace(" (", "(")
        .replace(", ", ",")
}

/// An integer type without its display width (`int(11)` of MariaDB and MySQL 5.7 is the
/// `int` of MySQL 8): it does not change what the column holds. `tinyint(1)` keeps it.
fn without_width(type_name: &str) -> String {
    match type_name.split_once('(') {
        Some((base, rest)) if kind_of(type_name) == "integer" => {
            let after = rest.split_once(')').map_or("", |(_, after)| after);
            format!("{base}{after}")
        }
        _ => type_name.to_string(),
    }
}

/// The numbers between the parentheses of a type: `(10,2)` of `numeric(10,2)`.
fn sizes(type_name: &str) -> Vec<String> {
    type_name
        .split_once('(')
        .and_then(|(_, rest)| rest.split_once(')'))
        .map(|(inside, _)| {
            inside
                .split(',')
                .map(|part| part.trim().to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// Whether a type of these sizes holds every value of one of those: digits before and after
/// the point for decimals, the length for the rest. A type without sizes, or of size `max`
/// (`nvarchar(max)` of SQL Server), holds any.
fn holds(kind: &str, source: &[String], target: &[String]) -> bool {
    let unbounded = |sizes: &[String]| sizes.iter().any(|size| size == "max");
    if unbounded(target) {
        return true;
    }
    if unbounded(source) {
        return target.is_empty();
    }
    let numbers = |sizes: &[String]| -> Option<Vec<u64>> {
        sizes.iter().map(|size| size.parse().ok()).collect()
    };
    let (Some(a), Some(b)) = (numbers(source), numbers(target)) else {
        return source == target;
    };
    match (kind, a.as_slice(), b.as_slice()) {
        (_, [], _) | (_, _, []) => true,
        ("decimal", [precision, rest @ ..], [other, others @ ..]) => {
            let (scale, scale_b) = (
                rest.first().copied().unwrap_or(0),
                others.first().copied().unwrap_or(0),
            );
            other.saturating_sub(scale_b) >= precision.saturating_sub(scale) && scale_b >= scale
        }
        (_, [length, ..], [other, ..]) => other >= length,
    }
}

/// The kind of value a type holds (`integer`, `decimal`, `text`…), as drivers name them.
pub fn kind_of(type_name: &str) -> &'static str {
    let lower = written(type_name);
    let base = lower.split('(').next().unwrap_or_default().trim();
    if lower == "tinyint(1)" || matches!(base, "bool" | "boolean" | "bit") {
        return "boolean";
    }
    let integers = [
        "int",
        "integer",
        "smallint",
        "bigint",
        "tinyint",
        "mediumint",
        "int2",
        "int4",
        "int8",
    ];
    let unsigned = base.strip_suffix(" unsigned").unwrap_or(base);
    if base.ends_with("serial") || integers.contains(&unsigned) {
        return "integer";
    }
    if matches!(
        base,
        "numeric" | "decimal" | "money" | "smallmoney" | "number" | "dec"
    ) {
        return "decimal";
    }
    if base.contains("float") || base.contains("double") || matches!(base, "real") {
        return "float";
    }
    if base.contains("timestamp with time zone") || matches!(base, "timestamptz" | "datetimeoffset")
    {
        return "timestamptz";
    }
    if base.starts_with("timestamp") || base.starts_with("datetime") || base == "smalldatetime" {
        return "timestamp";
    }
    if base == "date" {
        return "date";
    }
    if base.starts_with("time") {
        return "time";
    }
    if base.contains("char")
        || base.contains("text")
        || matches!(base, "string" | "clob" | "citext" | "name")
    {
        return "text";
    }
    if base.contains("blob") || base.contains("binary") || matches!(base, "bytea" | "image") {
        return "binary";
    }
    if base.starts_with("json") {
        return "json";
    }
    if matches!(base, "uuid" | "uniqueidentifier") {
        return "uuid";
    }
    if base == "xml" {
        return "xml";
    }
    "other"
}

/// How a column type of the source stands against the target's.
pub fn type_status(source: &str, target: &str, from: Dialect, to: Dialect) -> Status {
    let (a, b) = (written(source), written(target));
    if a == b || without_width(&a) == without_width(&b) {
        return Status::Equal;
    }
    if from == to {
        return Status::Different;
    }
    let column = SourceColumn {
        name: String::new(),
        kind: kind_of(source).into(),
        type_name: source.into(),
        nullable: None,
    };
    let copied = written(&convert(&column, from, to).sql_type);
    // What Nexo makes of it in the other engine, or a type of the same kind of values that
    // holds every value of the source's (`decimal(65,30)` holds `numeric(10,2)`; `longtext`,
    // `varchar(40)`).
    let (kind_a, kind_b) = (kind_of(source), kind_of(target));
    let sized = holds(kind_a, &sizes(&a), &sizes(&b));
    if copied == b || (kind_a == kind_b && kind_a != "other" && sized) {
        Status::Equivalent
    } else {
        Status::Different
    }
}
