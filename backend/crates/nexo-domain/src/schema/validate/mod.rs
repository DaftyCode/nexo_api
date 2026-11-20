//! A bounded JSON Schema validator (draft 2020-12, reading the drafts 4 to 7 forms too), for
//! the schema tests of scripts (`pm.response.to.have.jsonSchema`).
//!
//! It checks types, `enum` and `const`, the limits of numbers, strings, arrays and objects,
//! `properties`, `required`, `additionalProperties`, `items`, `prefixItems` and `contains`,
//! `allOf`, `anyOf`, `oneOf`, `not`, `if`/`then`/`else`, the formats of [`super::formats`]
//! and local `$ref` (`#/$defs/…`). Keywords it does not know are ignored, as JSON Schema
//! says. `pattern` needs the regular expressions of JavaScript: the strings it applies to are
//! returned in [`Validation::patterns`] for the script to check. Inside `anyOf`, `oneOf`,
//! `not` and `if`, patterns are not checked.
mod containers;
mod keywords;

#[cfg(test)]
mod tests;

use serde::Serialize;
use serde_json::Value;

/// Problems reported at most; the first ones say what is wrong.
const MAX_PROBLEMS: usize = 50;
/// Checks made at most, so that a schema of many branches cannot take long.
const MAX_STEPS: usize = 200_000;
/// `$ref` followed one inside another at most.
const MAX_REFS: usize = 64;

/// Where a value does not match its schema: a path such as `$.items[0].id`, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Problem {
    pub path: String,
    pub message: String,
}

/// A string that must match a `pattern`, left for JavaScript to check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PatternCheck {
    pub path: String,
    pub pattern: String,
    pub value: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Validation {
    pub problems: Vec<Problem>,
    pub patterns: Vec<PatternCheck>,
}

/// What `value` does not match of `schema`.
pub fn validate(schema: &Value, value: &Value) -> Validation {
    let mut checker = Checker {
        root: schema,
        steps: 0,
        refs: 0,
        patterns: true,
        result: Validation::default(),
    };
    checker.check(schema, value, "$");
    checker.result
}

struct Checker<'a> {
    root: &'a Value,
    steps: usize,
    refs: usize,
    /// Whether patterns are kept for the script; not inside branches that may fail.
    patterns: bool,
    result: Validation,
}

impl<'a> Checker<'a> {
    fn problem(&mut self, path: &str, message: impl Into<String>) {
        if self.result.problems.len() < MAX_PROBLEMS {
            self.result.problems.push(Problem {
                path: path.to_string(),
                message: message.into(),
            });
        }
    }

    /// Whether `value` matches `schema`, without reporting why: for `anyOf`, `oneOf`, `not`
    /// and `if`.
    fn passes(&mut self, schema: &'a Value, value: &Value) -> bool {
        let saved = std::mem::take(&mut self.result);
        let patterns = std::mem::replace(&mut self.patterns, false);
        self.check(schema, value, "$");
        let passed = self.result.problems.is_empty();
        self.result = saved;
        self.patterns = patterns;
        passed
    }

    fn check(&mut self, schema: &'a Value, value: &Value, path: &str) {
        self.steps += 1;
        if self.steps > MAX_STEPS {
            if self.steps == MAX_STEPS + 1 {
                self.problem(path, "The schema is too complex to check");
            }
            return;
        }
        let rules = match schema {
            Value::Bool(true) => return,
            Value::Bool(false) => return self.problem(path, "No value is allowed here"),
            Value::Object(rules) => rules,
            _ => return,
        };
        if let Some(reference) = rules.get("$ref").and_then(Value::as_str) {
            self.reference(reference, value, path);
        }
        keywords::check(self, rules, value, path);
    }

    /// A local reference: `#` or a JSON pointer inside the schema (`#/$defs/item`).
    fn reference(&mut self, reference: &str, value: &Value, path: &str) {
        let target = reference.strip_prefix('#').and_then(|pointer| {
            if pointer.is_empty() {
                Some(self.root)
            } else {
                self.root.pointer(pointer)
            }
        });
        let Some(target) = target else {
            return self.problem(
                path,
                format!("Only references inside the schema are checked: {reference}"),
            );
        };
        if self.refs >= MAX_REFS {
            return self.problem(path, "The schema refers to itself too deeply");
        }
        self.refs += 1;
        self.check(target, value, path);
        self.refs -= 1;
    }
}
