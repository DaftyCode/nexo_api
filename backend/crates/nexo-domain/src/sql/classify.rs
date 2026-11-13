//! What a statement does, from its words: reads, writes data, changes structure, controls a
//! transaction or sets the session. What cannot be told counts as a write. It also finds the
//! statements that need a confirmation: `UPDATE` and `DELETE` without `WHERE`, `TRUNCATE`
//! and `DROP`.
use super::vocabulary::{ACCESS, DROP_WORDS, READS, SESSION, STRUCTURE, TRANSACTION, WRITES};
use super::{
    Dialect,
    scanner::{Kind, Rules, Scanner},
};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StatementKind {
    Read,
    /// Changes data, or may: also calls of procedures and blocks of code.
    Write,
    /// Changes structure or permissions (DDL, DCL).
    Structure,
    Transaction,
    /// Sets the session (`SET`, `USE`) without touching data or the transaction's access.
    Session,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Classification {
    pub kind: StatementKind,
    /// An `UPDATE` or `DELETE` without `WHERE`: every row.
    pub missing_where: bool,
    pub truncate: bool,
    /// The objects a `DROP` removes, by their last name; empty for other statements.
    pub drop: Vec<String>,
    /// The statement is a `DROP`, even when its names could not be read.
    pub drops: bool,
}
impl Classification {
    /// Whether a read-only connection may run it.
    pub fn allowed_read_only(&self) -> bool {
        matches!(
            self.kind,
            StatementKind::Read | StatementKind::Transaction | StatementKind::Session
        )
    }
    /// Whether it changes data or structure.
    pub fn writes(&self) -> bool {
        matches!(self.kind, StatementKind::Write | StatementKind::Structure)
    }
}

/// A word or quoted name of the statement, with how deep in parentheses it is.
struct Word {
    upper: String,
    /// The name without its quotes.
    name: String,
    depth: u32,
    quoted: bool,
}

fn unquote(text: &str) -> String {
    let inner = match text.chars().next() {
        Some('"' | '\'' | '`') if text.len() >= 2 => &text[1..text.len() - 1],
        Some('[') if text.len() >= 2 => &text[1..text.len() - 1],
        _ => text,
    };
    inner.to_owned()
}

/// The words of a statement and whether it has `=` outside parentheses.
fn words(statement: &str, dialect: Dialect) -> (Vec<Word>, Vec<(usize, char, u32)>) {
    let mut scanner = Scanner::new(statement, Rules::of(dialect));
    let (mut words, mut symbols) = (Vec::new(), Vec::new());
    let mut depth: u32 = 0;
    while let Some(token) = scanner.next_token() {
        let text = &statement[token.start..token.end];
        match token.kind {
            Kind::Symbol => {
                let symbol = text.chars().next().unwrap_or(' ');
                if symbol == ')' {
                    depth = depth.saturating_sub(1);
                }
                symbols.push((words.len(), symbol, depth));
                if symbol == '(' {
                    depth += 1;
                }
            }
            Kind::Word | Kind::Quoted => words.push(Word {
                upper: text.to_ascii_uppercase(),
                name: unquote(text),
                depth,
                quoted: token.kind == Kind::Quoted,
            }),
        }
    }
    (words, symbols)
}

/// The names a `DROP` removes, from the words after it.
fn dropped(words: &[Word], symbols: &[(usize, char, u32)]) -> Vec<String> {
    let mut names = Vec::new();
    let mut index = 1;
    while index < words.len()
        && !words[index].quoted
        && DROP_WORDS.contains(&words[index].upper.as_str())
    {
        index += 1;
    }
    // Each name is the last part of a qualified name (`schema.table`); a comma separates them.
    let mut last: Option<String> = None;
    while index < words.len() {
        let word = &words[index];
        if !word.quoted
            && matches!(
                word.upper.as_str(),
                "CASCADE" | "RESTRICT" | "ON" | "PURGE" | "FORCE"
            )
        {
            break;
        }
        let comma_before = symbols
            .iter()
            .any(|(at, symbol, _)| *at == index && *symbol == ',');
        if comma_before && let Some(name) = last.take() {
            names.push(name);
        }
        last = Some(word.name.clone());
        index += 1;
    }
    names.extend(last);
    names
}

/// What a statement does. An empty statement reads nothing and is a read.
pub fn classify(statement: &str, dialect: Dialect) -> Classification {
    let (words, symbols) = words(statement, dialect);
    let mut result = Classification {
        kind: StatementKind::Write,
        missing_where: false,
        truncate: false,
        drop: Vec::new(),
        drops: false,
    };
    let Some(first) = words.first() else {
        result.kind = StatementKind::Read;
        return result;
    };
    let top = |word: &&Word| word.depth == 0 && !word.quoted;
    // The verb of the statement: after the common table expressions of a `WITH`.
    let verb_index = if first.upper == "WITH" {
        words
            .iter()
            .position(|word| {
                top(&word)
                    && (READS.contains(&word.upper.as_str())
                        || WRITES.contains(&word.upper.as_str()))
            })
            .unwrap_or(0)
    } else {
        0
    };
    let verb = words[verb_index].upper.as_str();
    // A common table expression may change data itself (`WITH gone AS (DELETE …)`).
    let cte_writes = first.upper == "WITH"
        && words
            .iter()
            .any(|word| !word.quoted && WRITES.contains(&word.upper.as_str()));
    let after = &words[verb_index + 1..];
    let has = |name: &str| after.iter().filter(top).any(|word| word.upper == name);
    result.kind = match verb {
        _ if cte_writes => StatementKind::Write,
        "SELECT" if has("INTO") => StatementKind::Write,
        "EXPLAIN" => {
            let analyzed = after.iter().any(|word| word.upper == "ANALYZE");
            let changes = after.iter().any(|word| {
                WRITES.contains(&word.upper.as_str()) || STRUCTURE.contains(&word.upper.as_str())
            });
            if analyzed && changes {
                StatementKind::Write
            } else {
                StatementKind::Read
            }
        }
        "PRAGMA"
            if symbols
                .iter()
                .any(|(_, symbol, depth)| *symbol == '=' && *depth == 0) =>
        {
            StatementKind::Write
        }
        "PRAGMA" => StatementKind::Read,
        _ if READS.contains(&verb) => StatementKind::Read,
        _ if WRITES.contains(&verb) => StatementKind::Write,
        _ if STRUCTURE.contains(&verb) => StatementKind::Structure,
        "BEGIN" if matches!(dialect, Dialect::TSql | Dialect::PlSql) => {
            match words.get(1).map(|word| word.upper.as_str()) {
                Some("TRAN" | "TRANSACTION" | "DISTRIBUTED") => StatementKind::Transaction,
                _ => StatementKind::Write,
            }
        }
        "BEGIN" => StatementKind::Transaction,
        _ if TRANSACTION.contains(&verb) => StatementKind::Transaction,
        _ if SESSION.contains(&verb) => {
            if words
                .iter()
                .any(|word| ACCESS.contains(&word.upper.as_str()))
            {
                StatementKind::Write
            } else {
                StatementKind::Session
            }
        }
        _ => StatementKind::Write,
    };
    match verb {
        "UPDATE" | "DELETE" => result.missing_where = !has("WHERE"),
        "TRUNCATE" => result.truncate = true,
        "DROP" => {
            result.drops = true;
            result.drop = dropped(&words[verb_index..], &shifted(&symbols, verb_index));
        }
        _ => {}
    }
    result
}

/// The symbols, numbered from the word at `from`.
fn shifted(symbols: &[(usize, char, u32)], from: usize) -> Vec<(usize, char, u32)> {
    symbols
        .iter()
        .filter(|(at, _, _)| *at >= from)
        .map(|(at, symbol, depth)| (at - from, *symbol, *depth))
        .collect()
}
