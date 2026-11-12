//! Table tests over the definitions in `fixtures/`: a valid one, one with known problems, a
//! Swagger 2.0 one and a second version of the valid one with known changes.

mod diff;
mod lint;

use super::*;

const VALID: &str = include_str!("../fixtures/valid.yaml");
const CHANGED: &str = include_str!("../fixtures/changed.yaml");
const ERRORS: &str = include_str!("../fixtures/errors.yaml");
const SWAGGER: &str = include_str!("../fixtures/swagger.yaml");

fn inspect_source(source: &str) -> Value {
    inspect(&json!({"source": source})).unwrap()
}
/// The findings as `(severity, rule, params, line)`.
fn findings(source: &str) -> Vec<(String, String, Vec<String>, u64)> {
    inspect_source(source)["findings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|finding| {
            (
                finding["severity"].as_str().unwrap().to_string(),
                finding["rule"].as_str().unwrap().to_string(),
                finding["params"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|p| p.as_str().unwrap().to_string())
                    .collect(),
                finding["line"].as_u64().unwrap_or(0),
            )
        })
        .collect()
}
fn row(
    severity: &str,
    rule: &str,
    params: &[&str],
    line: u64,
) -> (String, String, Vec<String>, u64) {
    (
        severity.into(),
        rule.into(),
        params.iter().map(|p| p.to_string()).collect(),
        line,
    )
}

/// The changes of one endpoint as `(rule, params, breaking)`.
fn changes_of(diff: &Value, method: &str, path: &str) -> Vec<(String, Vec<String>, bool)> {
    diff["changed"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["method"] == method && entry["path"] == path)
        .map(|entry| {
            entry["changes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|change| {
                    (
                        change["rule"].as_str().unwrap().to_string(),
                        change["params"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|p| p.as_str().unwrap().to_string())
                            .collect(),
                        change["breaking"].as_bool().unwrap(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}
fn change(rule: &str, params: &[&str], breaking: bool) -> (String, Vec<String>, bool) {
    (
        rule.into(),
        params.iter().map(|p| p.to_string()).collect(),
        breaking,
    )
}

#[test]
fn every_rule_has_its_message_in_both_languages() {
    let messages = [
        include_str!("../../../../../../src/app/infrastructure/i18n/en.json"),
        include_str!("../../../../../../src/app/infrastructure/i18n/es.json"),
    ];
    let rules = |source: &str| -> Vec<String> {
        source
            .split('"')
            .skip(1)
            .step_by(2)
            .filter(|text| {
                text.len() > 3
                    && text.contains('-')
                    && text
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c == '-' || c.is_ascii_digit())
                    && *text != "kebab-case"
            })
            .map(String::from)
            .collect()
    };
    for (prefix, source) in [
        (
            "lint",
            concat!(
                include_str!("../lint/mod.rs"),
                include_str!("../lint/rules.rs")
            ),
        ),
        (
            "diff",
            concat!(
                include_str!("../diff/mod.rs"),
                include_str!("../diff/operations.rs"),
                include_str!("../diff/schemas.rs")
            ),
        ),
    ] {
        let found = rules(source);
        assert!(found.len() > 10, "{prefix}: {found:?}");
        for rule in found {
            for language in messages {
                assert!(
                    language.contains(&format!("\"{prefix}.{rule}\"")),
                    "{prefix}.{rule} has no message"
                );
            }
        }
    }
    for language in messages {
        assert!(language.contains("\"lint.parse\""));
    }
}
