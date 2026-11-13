//! Splits a script into its statements, as DBeaver's script parser does: by the delimiter,
//! never inside strings, comments or blocks, and with the commands of each dialect that are
//! not SQL (`DELIMITER` of MySQL, `GO` of SQL Server, `/` of Oracle).
use super::{
    Dialect,
    scanner::{Kind, Rules, Scanner},
};
use serde::Serialize;

/// A statement of a script, without its delimiter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Statement {
    pub text: String,
    /// Where it starts and ends in the script, in UTF-16 code units (as editors count).
    pub start: usize,
    pub end: usize,
    /// The line it starts on, from 1.
    pub line: usize,
}

/// Counts UTF-16 units and lines up to a byte offset, moving forward only.
struct Positions<'a> {
    text: &'a str,
    byte: usize,
    utf16: usize,
    line: usize,
}
impl Positions<'_> {
    fn at(&mut self, byte: usize) -> (usize, usize) {
        for character in self.text[self.byte..byte].chars() {
            self.utf16 += character.len_utf16();
            if character == '\n' {
                self.line += 1;
            }
        }
        self.byte = byte;
        (self.utf16, self.line)
    }
}

/// The statement being read: where it starts and what opens a block in it.
#[derive(Default)]
struct Current {
    start: Option<usize>,
    end: usize,
    /// Words read so far, upper case (only the first few matter).
    words: Vec<String>,
    /// BEGIN and CASE not yet closed by END (SQL Server).
    depth: u32,
    /// A `BEGIN` whose next word says whether it opens a block.
    pending_begin: bool,
    /// A block that only `GO` or `/` ends: a procedure of SQL Server, a PL/SQL block.
    block: bool,
}

/// Whether the first words open a block that only a line with `/` (Oracle) or `GO` (SQL
/// Server) ends.
fn opens_block(dialect: Dialect, words: &[String]) -> bool {
    let words: Vec<&str> = words.iter().map(String::as_str).collect();
    let skip = |words: &[&str]| -> usize {
        match words {
            ["CREATE", "OR", "REPLACE", ..] | ["CREATE", "OR", "ALTER", ..] => 3,
            ["CREATE" | "ALTER", ..] => 1,
            _ => 0,
        }
    };
    match dialect {
        Dialect::PlSql => {
            if matches!(words.first(), Some(&"DECLARE" | &"BEGIN")) {
                return true;
            }
            let after = skip(&words);
            let rest: Vec<&str> = words[after.min(words.len())..]
                .iter()
                .copied()
                .filter(|word| !matches!(*word, "EDITIONABLE" | "NONEDITIONABLE"))
                .collect();
            after > 0
                && matches!(
                    rest.first(),
                    Some(&"FUNCTION" | &"PROCEDURE" | &"PACKAGE" | &"TRIGGER" | &"TYPE")
                )
        }
        Dialect::TSql => {
            let after = skip(&words);
            after > 0
                && matches!(
                    words.get(after),
                    Some(&"PROC" | &"PROCEDURE" | &"FUNCTION" | &"TRIGGER" | &"VIEW")
                )
        }
        _ => false,
    }
}

/// Whether a line is the batch separator of SQL Server: `GO`, or `GO` and a count.
fn is_go(line: &str) -> bool {
    let mut parts = line.split_whitespace();
    parts
        .next()
        .is_some_and(|word| word.eq_ignore_ascii_case("GO"))
        && parts
            .next()
            .is_none_or(|count| count.bytes().all(|b| b.is_ascii_digit()))
        && parts.next().is_none()
}

/// The statements of a script, in order. Statements with only comments are left out.
pub fn split(script: &str, dialect: Dialect) -> Vec<Statement> {
    let mut scanner = Scanner::new(script, Rules::of(dialect));
    let mut positions = Positions {
        text: script,
        byte: 0,
        utf16: 0,
        line: 1,
    };
    let mut statements = Vec::new();
    let mut current = Current::default();
    let mut delimiter = String::from(";");
    let mut finish = |current: &mut Current, statements: &mut Vec<Statement>| {
        if let Some(start) = current.start {
            let text = script[start..current.end].trim_end();
            let (begin, line) = positions.at(start);
            let (end, _) = positions.at(start + text.len());
            statements.push(Statement {
                text: text.to_owned(),
                start: begin,
                end,
                line,
            });
        }
        *current = Current::default();
    };
    while let Some(token) = scanner.next_token() {
        if token.line_start {
            let line = scanner.line_of(token.start).trim();
            let command = match dialect {
                Dialect::TSql => is_go(line),
                Dialect::PlSql => line == "/",
                Dialect::MySql => {
                    current.start.is_none()
                        && line
                            .get(..10)
                            .is_some_and(|word| word.eq_ignore_ascii_case("DELIMITER "))
                }
                _ => false,
            };
            if command {
                if dialect == Dialect::MySql {
                    let named = line[10..].split_whitespace().next();
                    delimiter = named.unwrap_or(";").to_owned();
                }
                finish(&mut current, &mut statements);
                scanner.skip_line();
                continue;
            }
        }
        if token.kind == Kind::Symbol
            && !current.block
            && current.depth == 0
            && script[token.start..].starts_with(delimiter.as_str())
        {
            if current.pending_begin {
                // `BEGIN;` of SQL Server: a block that the delimiter does not end.
                current.pending_begin = false;
                current.depth += 1;
            } else {
                scanner.pos = token.start + delimiter.len();
                finish(&mut current, &mut statements);
                continue;
            }
        }
        current.start.get_or_insert(token.start);
        current.end = token.end;
        if token.kind == Kind::Word {
            read_word(&mut current, dialect, &script[token.start..token.end]);
        }
    }
    finish(&mut current, &mut statements);
    statements
}

fn read_word(current: &mut Current, dialect: Dialect, word: &str) {
    let word = word.to_ascii_uppercase();
    if dialect == Dialect::TSql {
        if current.pending_begin {
            current.pending_begin = false;
            if !matches!(
                word.as_str(),
                "TRAN" | "TRANSACTION" | "DISTRIBUTED" | "DIALOG" | "CONVERSATION"
            ) {
                current.depth += 1;
            }
        }
        match word.as_str() {
            "BEGIN" => current.pending_begin = true,
            "CASE" => current.depth += 1,
            "END" => current.depth = current.depth.saturating_sub(1),
            _ => {}
        }
    }
    if current.words.len() < 6 {
        current.words.push(word);
        if !current.block && opens_block(dialect, &current.words) {
            current.block = true;
        }
    }
}

/// The statement at `offset` (in UTF-16 units): the one that contains it, else the last one
/// before it, else the first one.
pub fn statement_at(statements: &[Statement], offset: usize) -> Option<&Statement> {
    statements
        .iter()
        .find(|statement| statement.start <= offset && offset <= statement.end)
        .or_else(|| {
            statements
                .iter()
                .rev()
                .find(|statement| statement.end <= offset)
        })
        .or_else(|| statements.first())
}
