//! The columns a connection hides from MCP agents (`mcpHidden`): `table.column`, a bare
//! `column`, or patterns with `*` (`*.password`, `*_token`), without regard to case. A column
//! of a result is hidden by where it comes from, whatever its alias; when the driver does not
//! say where, it is hidden if its name matches, or if the statement names a table with hidden
//! columns or a hidden column itself.
use serde_json::Value;

pub(super) const MASK: &str = "[hidden]";

/// A pattern with `*`, matched without regard to case.
fn matches(pattern: &str, text: &str) -> bool {
    let text = text.to_lowercase();
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == text;
    }
    let (first, last) = (parts[0], parts[parts.len() - 1]);
    if !text.starts_with(first) || text.len() < first.len() + last.len() || !text.ends_with(last) {
        return false;
    }
    let mut at = first.len();
    let end = text.len() - last.len();
    for part in &parts[1..parts.len() - 1] {
        match text[at..end].find(part) {
            Some(found) => at += found + part.len(),
            None => return false,
        }
    }
    true
}

#[derive(Debug, Default)]
pub(super) struct Hidden(Vec<(Option<String>, String)>);

impl Hidden {
    pub(super) fn read(value: &Value) -> Self {
        let rules = value
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(|rule| rule.trim().to_lowercase())
            .filter(|rule| !rule.is_empty())
            .map(|rule| match rule.rsplit_once('.') {
                // `schema.table.column` names the table by its last part.
                Some((table, column)) => (
                    Some(table.rsplit('.').next().unwrap_or(table).to_owned()),
                    column.to_owned(),
                ),
                None => (None, rule),
            })
            .collect();
        Self(rules)
    }

    fn hides(&self, table: Option<&str>, column: &str) -> bool {
        self.0.iter().any(|(rule_table, rule_column)| {
            matches(rule_column, column)
                && match (rule_table, table) {
                    (None, _) => true,
                    (Some(rule), Some(table)) => matches(rule, table),
                    (Some(_), None) => false,
                }
        })
    }

    /// Which columns of a result are hidden, in order.
    pub(super) fn columns(&self, columns: &[Value], sql: &str) -> Vec<bool> {
        if self.0.is_empty() {
            return vec![false; columns.len()];
        }
        let words: Vec<String> = sql
            .split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '$'))
            .filter(|word| !word.is_empty())
            .map(str::to_lowercase)
            .collect();
        let named = |pattern: &str| words.iter().any(|word| matches(pattern, word));
        // Unknown origins: the statement reads something hidden.
        let risky = self.0.iter().any(|(table, column)| match table {
            Some(table) => named(table),
            None => named(column),
        });
        columns
            .iter()
            .map(|column| {
                let origin = &column["origin"];
                match (origin["table"].as_str(), origin["column"].as_str()) {
                    (Some(table), Some(name)) => self.hides(Some(table), name),
                    _ => risky || self.hides(None, column["name"].as_str().unwrap_or_default()),
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn column(name: &str, origin: Option<(&str, &str)>) -> Value {
        match origin {
            Some((table, column)) => {
                json!({"name": name, "origin": {"table": table, "column": column}})
            }
            None => json!({"name": name}),
        }
    }

    #[test]
    fn a_column_is_hidden_by_where_it_comes_from_whatever_its_alias() {
        let hidden = Hidden::read(&json!(["users.password", "*_token", "public.cards.Number"]));
        let columns = [
            column("p", Some(("users", "password"))),
            column("name", Some(("users", "name"))),
            column("t", Some(("sessions", "refresh_token"))),
            column("n", Some(("cards", "number"))),
            column("password", Some(("other", "password"))),
        ];
        assert_eq!(
            hidden.columns(&columns, "select password as p, name from users"),
            [true, false, true, true, false]
        );
    }

    #[test]
    fn without_an_origin_a_column_is_hidden_when_the_statement_reads_what_is_hidden() {
        let hidden = Hidden::read(&json!(["users.password", "secret"]));
        let columns = [column("x", None), column("y", None)];
        assert_eq!(
            hidden.columns(&columns, "select upper(password) x, 1 y from USERS"),
            [true, true]
        );
        assert_eq!(
            hidden.columns(&columns, "select 1 x, 2 y from orders"),
            [false, false]
        );
        assert_eq!(
            hidden.columns(&[column("secret", None)], "select * from t"),
            [true]
        );
        assert_eq!(
            hidden.columns(&columns, "select secret x from t"),
            [true, true]
        );
        assert_eq!(
            Hidden::read(&json!(null)).columns(&columns, "select"),
            [false, false]
        );
    }

    #[test]
    fn patterns_match_without_regard_to_case() {
        assert!(matches("*_token", "REFRESH_TOKEN"));
        assert!(matches("a*b*c", "axxbyyc"));
        assert!(!matches("a*b*c", "axxc"));
        assert!(!matches("*_token", "token"));
        assert!(matches("*", "anything"));
        assert!(!matches("name", "names"));
    }
}
