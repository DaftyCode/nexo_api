//! Test data (DB-27, DBeaver's «Mock data generation»): a generator for each column of a
//! table, with a seed, so the same seed makes the same rows. Each cell is drawn from the seed,
//! its column and its row alone, so a batch can be made anywhere in the run. A column that must
//! be unique gets unique values by construction (a permutation of its range, or its row in the
//! text) instead of retrying; the database refuses whatever still collides, and the import
//! counts it and goes on.
mod catalogs;
mod rng;
#[cfg(test)]
mod tests;
mod text;

pub use catalogs::{Catalog, Language};
use rng::{Rng, permuted};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use text::{base64, cut, template, unique_text};

use crate::{Error, Result};

/// Rows of one run, at most, and of one batch.
pub const MAX_ROWS: u64 = 1_000_000;
pub const MAX_BATCH: u32 = 5_000;
/// Values a list or the keys of a referenced table may give, at most.
pub const MAX_VALUES: usize = 10_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Generator {
    Sequence {
        start: i64,
        step: i64,
    },
    Integer {
        min: i64,
        max: i64,
    },
    Decimal {
        min: f64,
        max: f64,
        scale: u32,
    },
    Text {
        min: u32,
        max: u32,
    },
    List {
        values: Vec<String>,
    },
    /// `A` a capital letter, `a` a small one, `9` a digit, `?` either; the rest as it is.
    Pattern {
        pattern: String,
    },
    Catalog {
        catalog: Catalog,
        #[serde(default)]
        language: Language,
    },
    Date {
        from: String,
        to: String,
    },
    Timestamp {
        from: String,
        to: String,
    },
    Boolean {
        ratio: f64,
    },
    /// JSON text where `{{row}}`, `{{uuid}}`, `{{int}}`, `{{word}}` and the catalogs' names
    /// (`{{firstName}}`, `{{email}}`…) are replaced.
    Json {
        template: String,
    },
    Binary {
        size: u32,
    },
    /// A value of the referenced table: its keys, read before.
    Foreign {
        values: Vec<Value>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MockColumn {
    pub name: String,
    pub generator: Generator,
    /// The share of `NULL`, from 0 to 1, in a column that takes it.
    #[serde(default)]
    pub nulls: f64,
    #[serde(default)]
    pub unique: bool,
    /// The longest text the column takes.
    #[serde(default)]
    pub length: Option<u32>,
}

fn invalid(column: &str, why: &str) -> Error {
    Error::Validation(format!("The test data of {column}: {why}"))
}

/// Checks the generators of a run before anything is made.
pub fn validate(columns: &[MockColumn]) -> Result<()> {
    if columns.is_empty() {
        return Err(Error::Validation(
            "Choose at least one column to fill".into(),
        ));
    }
    for column in columns {
        let name = column.name.as_str();
        if !(0.0..=1.0).contains(&column.nulls) {
            return Err(invalid(name, "the share of NULL is from 0 to 1"));
        }
        match &column.generator {
            Generator::Integer { min, max } if min > max => {
                return Err(invalid(name, "the smallest number is above the largest"));
            }
            Generator::Decimal { min, max, scale } if min > max || *scale > 12 => {
                return Err(invalid(
                    name,
                    "a range from the smallest to the largest, 12 decimals at most",
                ));
            }
            Generator::Text { min, max } if min > max || *max > 10_000 => {
                return Err(invalid(
                    name,
                    "a length from the shortest to the longest, 10,000 at most",
                ));
            }
            Generator::List { values } if values.is_empty() || values.len() > MAX_VALUES => {
                return Err(invalid(name, "a list of 1 to 10,000 values"));
            }
            Generator::Foreign { values } if values.len() > MAX_VALUES => {
                return Err(invalid(name, "10,000 keys at most"));
            }
            Generator::Pattern { pattern } if pattern.is_empty() || pattern.len() > 1_000 => {
                return Err(invalid(name, "a pattern of 1 to 1,000 characters"));
            }
            Generator::Date { from, to } | Generator::Timestamp { from, to } => {
                let (Some(from), Some(to)) = (catalogs::days(from), catalogs::days(to)) else {
                    return Err(invalid(name, "dates as YYYY-MM-DD"));
                };
                if from > to {
                    return Err(invalid(name, "the first date is after the last one"));
                }
            }
            Generator::Boolean { ratio } if !(0.0..=1.0).contains(ratio) => {
                return Err(invalid(name, "the share of true is from 0 to 1"));
            }
            Generator::Json { template } if template.len() > 10_000 => {
                return Err(invalid(name, "a template of 10,000 characters at most"));
            }
            Generator::Binary { size } if *size > 1_048_576 => {
                return Err(invalid(name, "1 MB at most"));
            }
            _ => {}
        }
    }
    Ok(())
}

/// The value of one cell.
fn cell(column: &MockColumn, rng: &mut Rng, row: u64, seed: u64) -> Value {
    let unique = column.unique;
    let text = |value: String| Value::String(cut(value, column.length));
    let unique_or = |value: String| {
        Value::String(if unique {
            unique_text(value, row, column.length)
        } else {
            cut(value, column.length)
        })
    };
    match &column.generator {
        Generator::Sequence { start, step } => {
            json!(start.saturating_add((row as i64).saturating_mul(*step)))
        }
        Generator::Integer { min, max } => {
            let size = (*max as i128 - *min as i128 + 1).min(u64::MAX as i128) as u64;
            let at = if unique {
                permuted(row, size, seed)
            } else {
                rng.below(size)
            };
            json!((*min as i128 + at as i128) as i64)
        }
        Generator::Decimal { min, max, scale } => {
            let factor = 10_f64.powi(*scale as i32);
            let steps = (((max - min) * factor).floor() as u64).saturating_add(1);
            let at = if unique {
                permuted(row, steps, seed)
            } else {
                rng.below(steps)
            };
            json!(((min * factor).round() + at as f64) / factor)
        }
        Generator::Text { min, max } => {
            let length = *min as u64 + rng.below(u64::from(max - min) + 1);
            let words: String = (0..length)
                .map(|at| if at % 7 == 6 { ' ' } else { rng.letter(false) })
                .collect();
            unique_or(words.trim_end().to_string())
        }
        Generator::List { values } => {
            let at = if unique {
                permuted(row, values.len() as u64, seed)
            } else {
                rng.below(values.len() as u64)
            };
            text(values[at as usize].clone())
        }
        Generator::Pattern { pattern } => unique_or(
            pattern
                .chars()
                .map(|c| match c {
                    'A' => rng.letter(true),
                    'a' => rng.letter(false),
                    '9' => rng.digit(),
                    '?' if rng.below(2) == 0 => rng.digit(),
                    '?' => rng.letter(true),
                    other => other,
                })
                .collect(),
        ),
        Generator::Catalog { catalog, language } => {
            let value = catalogs::value(*catalog, *language, rng);
            if *catalog == Catalog::Uuid {
                text(value)
            } else {
                unique_or(value)
            }
        }
        Generator::Date { from, to } | Generator::Timestamp { from, to } => {
            let (from, to) = (
                catalogs::days(from).unwrap_or(0),
                catalogs::days(to).unwrap_or(0),
            );
            let size = (to - from + 1) as u64;
            let day = from
                + if unique {
                    permuted(row, size, seed)
                } else {
                    rng.below(size)
                } as i64;
            let date = catalogs::date(day);
            if matches!(column.generator, Generator::Date { .. }) {
                Value::String(date)
            } else {
                let seconds = rng.below(86_400);
                Value::String(format!(
                    "{date} {:02}:{:02}:{:02}",
                    seconds / 3_600,
                    seconds / 60 % 60,
                    seconds % 60
                ))
            }
        }
        Generator::Boolean { ratio } => Value::Bool(rng.unit() < *ratio),
        Generator::Json { template: text } => Value::String(template(text, row, rng)),
        Generator::Binary { size } => {
            let bytes: Vec<u8> = (0..*size).map(|_| rng.below(256) as u8).collect();
            json!({"$t": "binary", "v": base64(&bytes)})
        }
        Generator::Foreign { values } if values.is_empty() => Value::Null,
        Generator::Foreign { values } => {
            let at = if unique {
                permuted(row, values.len() as u64, seed)
            } else {
                rng.below(values.len() as u64)
            };
            values[at as usize].clone()
        }
    }
}

/// The rows `first` to `first + count - 1` of a run with `seed`, one value per column.
pub fn rows(columns: &[MockColumn], seed: u64, first: u64, count: u32) -> Vec<Vec<Value>> {
    (first..first.saturating_add(u64::from(count)))
        .map(|row| {
            columns
                .iter()
                .enumerate()
                .map(|(index, column)| {
                    let mut rng = Rng::new(seed, index, row);
                    if column.nulls > 0.0 && rng.unit() < column.nulls {
                        Value::Null
                    } else {
                        cell(column, &mut rng, row, seed.wrapping_add(index as u64))
                    }
                })
                .collect()
        })
        .collect()
}
