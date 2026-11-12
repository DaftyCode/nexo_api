//! Names and literals of a SQL query as MongoDB has them: a column becomes a field path (the
//! fields of a joined table live under its alias), a literal an Extended JSON value.
use nexo_domain::{Error, Result};
use serde_json::{Value, json};
use sqlparser::ast::{
    DataType, Expr, FunctionArg, FunctionArgExpr, FunctionArguments, ObjectName, ObjectNamePart,
    UnaryOperator, Value as Literal,
};

pub(super) fn unsupported(what: impl std::fmt::Display) -> Error {
    Error::Validation(format!("This SQL is not supported: {what}"))
}

/// The tables of the query: the collection read and the joined ones, by alias.
#[derive(Default)]
pub(super) struct Scope {
    /// The names the collection read is known by (its name and its alias).
    pub base: Vec<String>,
    /// The aliases of the joined collections; their fields live under the alias.
    pub joined: Vec<String>,
}

impl Scope {
    /// The field a column names.
    pub fn field(&self, expr: &Expr) -> Result<String> {
        let parts: Vec<String> = match expr {
            Expr::Identifier(ident) => vec![ident.value.clone()],
            Expr::CompoundIdentifier(idents) => {
                idents.iter().map(|ident| ident.value.clone()).collect()
            }
            Expr::Nested(inner) => return self.field(inner),
            other => return Err(unsupported(format!("{other} is not a column"))),
        };
        if parts.len() > 1 && self.base.contains(&parts[0]) {
            return Ok(parts[1..].join("."));
        }
        Ok(parts.join("."))
    }
    pub fn is_column(expr: &Expr) -> bool {
        matches!(expr, Expr::Identifier(_) | Expr::CompoundIdentifier(_))
    }
}

/// The last part of an object name: a table or a function.
pub(super) fn name(object: &ObjectName) -> String {
    object
        .0
        .last()
        .and_then(|part| match part {
            ObjectNamePart::Identifier(ident) => Some(ident.value.clone()),
            _ => None,
        })
        .unwrap_or_default()
}

/// A number as JSON: whole numbers stay whole.
fn number(text: &str, negative: bool) -> Result<Value> {
    let signed = if negative {
        format!("-{text}")
    } else {
        text.to_string()
    };
    if let Ok(whole) = signed.parse::<i64>() {
        return Ok(json!(whole));
    }
    signed
        .parse::<f64>()
        .ok()
        .filter(|number| number.is_finite())
        .map(|number| json!(number))
        .ok_or_else(|| unsupported(format!("the number {signed}")))
}

/// A date or timestamp literal as an Extended JSON date.
fn date(text: &str) -> Result<Value> {
    let text = text.trim().replace(' ', "T");
    let iso = if text.len() == 10 {
        format!("{text}T00:00:00Z")
    } else if text.ends_with('Z') || text[10..].contains(['+', '-']) {
        text
    } else {
        format!("{text}Z")
    };
    let valid = iso.len() >= 20
        && iso.as_bytes()[4] == b'-'
        && iso.as_bytes()[7] == b'-'
        && iso[..4].chars().all(|c| c.is_ascii_digit());
    if !valid {
        return Err(unsupported(format!(
            "the date {iso}: write it as '2024-01-02' or '2024-01-02 03:04:05'"
        )));
    }
    Ok(json!({ "$date": iso }))
}

/// A literal value: numbers, text, booleans, null, `DATE '…'`, `TIMESTAMP '…'` and
/// `ObjectId('…')`.
pub(super) fn literal(expr: &Expr) -> Result<Value> {
    match expr {
        Expr::Value(value) => match &value.value {
            Literal::Number(text, _) => number(text, false),
            Literal::SingleQuotedString(text) => Ok(json!(text)),
            Literal::Boolean(value) => Ok(json!(value)),
            Literal::Null => Ok(Value::Null),
            other => Err(unsupported(format!("the value {other}"))),
        },
        Expr::UnaryOp {
            op: UnaryOperator::Minus,
            expr,
        } => match expr.as_ref() {
            Expr::Value(value) => match &value.value {
                Literal::Number(text, _) => number(text, true),
                other => Err(unsupported(format!("-{other}"))),
            },
            other => Err(unsupported(format!("-{other}"))),
        },
        Expr::TypedString(typed) => match (&typed.data_type, &typed.value.value) {
            (
                DataType::Date | DataType::Timestamp(..) | DataType::Datetime(_),
                Literal::SingleQuotedString(text),
            ) => date(text),
            _ => Err(unsupported(expr)),
        },
        Expr::Function(function) if name(&function.name).eq_ignore_ascii_case("objectid") => {
            let text = match &function.args {
                FunctionArguments::List(list) => match list.args.as_slice() {
                    [FunctionArg::Unnamed(FunctionArgExpr::Expr(Expr::Value(value)))] => {
                        match &value.value {
                            Literal::SingleQuotedString(text) => Some(text.clone()),
                            _ => None,
                        }
                    }
                    _ => None,
                },
                _ => None,
            };
            match text {
                Some(hex) if hex.len() == 24 && hex.chars().all(|c| c.is_ascii_hexdigit()) => {
                    Ok(json!({ "$oid": hex.to_ascii_lowercase() }))
                }
                _ => Err(unsupported(format!(
                    "{expr}: an ObjectId is 24 hexadecimal characters"
                ))),
            }
        }
        Expr::Nested(inner) => literal(inner),
        other => Err(unsupported(format!("{other} is not a value"))),
    }
}

/// Whether an expression is a literal value.
pub(super) fn is_literal(expr: &Expr) -> bool {
    literal(expr).is_ok()
}

/// A LIKE pattern as an anchored regular expression: `%` any text, `_` one character.
pub(super) fn like(pattern: &str) -> String {
    let mut regex = String::from("^");
    for character in pattern.chars() {
        match character {
            '%' => regex.push_str(".*"),
            '_' => regex.push('.'),
            c if "\\^$.|?*+()[]{}".contains(c) => {
                regex.push('\\');
                regex.push(c);
            }
            c => regex.push(c),
        }
    }
    regex.push('$');
    regex
}
