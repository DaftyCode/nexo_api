//! Reads SQL text token by token, skipping whitespace and comments and keeping strings and
//! quoted names whole, with the quoting rules of each dialect.
use super::Dialect;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    /// A keyword or a plain name.
    Word,
    /// A string or a quoted name.
    Quoted,
    /// Anything else: operators, punctuation, numbers' digits after a word.
    Symbol,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Token {
    pub kind: Kind,
    pub start: usize,
    pub end: usize,
    /// Only whitespace stands between the start of its line and it.
    pub line_start: bool,
}

/// How a dialect writes strings, names and comments.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct Rules {
    /// `$tag$ … $tag$` (PostgreSQL).
    pub dollar_quotes: bool,
    /// `/* /* */ */` (PostgreSQL).
    pub nested_comments: bool,
    /// `#` comments and `\'` escapes in strings, `"…"` as strings (MySQL).
    pub mysql: bool,
    /// `` `name` `` (MySQL, SQLite).
    pub backticks: bool,
    /// `[name]` (SQL Server, SQLite).
    pub brackets: bool,
    /// `q'[…]'` alternative quoting (Oracle).
    pub q_quotes: bool,
}
impl Rules {
    pub fn of(dialect: Dialect) -> Self {
        match dialect {
            Dialect::PostgreSql => Self {
                dollar_quotes: true,
                nested_comments: true,
                ..Self::default()
            },
            Dialect::MySql => Self {
                mysql: true,
                backticks: true,
                ..Self::default()
            },
            Dialect::TSql => Self {
                brackets: true,
                ..Self::default()
            },
            Dialect::PlSql => Self {
                q_quotes: true,
                ..Self::default()
            },
            Dialect::Sqlite => Self {
                backticks: true,
                brackets: true,
                ..Self::default()
            },
            Dialect::Ansi => Self::default(),
        }
    }
}

pub(crate) struct Scanner<'a> {
    pub text: &'a str,
    bytes: &'a [u8],
    pub pos: usize,
    rules: Rules,
    /// The current line has had only whitespace so far.
    at_line_start: bool,
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte >= 0x80
}

impl<'a> Scanner<'a> {
    pub fn new(text: &'a str, rules: Rules) -> Self {
        Self {
            text,
            bytes: text.as_bytes(),
            pos: 0,
            rules,
            at_line_start: true,
        }
    }
    fn peek(&self, offset: usize) -> Option<u8> {
        self.bytes.get(self.pos + offset).copied()
    }
    /// Moves to the end of the line, before its line break.
    pub fn skip_line(&mut self) {
        while let Some(byte) = self.peek(0) {
            if byte == b'\n' {
                break;
            }
            self.pos += 1;
        }
    }
    /// The text of the line `position` is on, without its line break.
    pub fn line_of(&self, position: usize) -> &'a str {
        let start = self.text[..position]
            .rfind('\n')
            .map_or(0, |index| index + 1);
        let end = self.text[position..]
            .find('\n')
            .map_or(self.text.len(), |index| position + index);
        self.text[start..end].trim_end_matches('\r')
    }

    /// Skips whitespace and comments.
    fn skip_trivia(&mut self) {
        while let Some(byte) = self.peek(0) {
            match byte {
                b'\n' => {
                    self.at_line_start = true;
                    self.pos += 1;
                }
                b' ' | b'\t' | b'\r' | 0x0b | 0x0c => self.pos += 1,
                b'-' if self.peek(1) == Some(b'-') => self.skip_line(),
                b'#' if self.rules.mysql => self.skip_line(),
                // MySQL runs what is inside `/*! … */`: it is not a comment.
                b'/' if self.peek(1) == Some(b'*')
                    && !(self.rules.mysql && self.peek(2) == Some(b'!')) =>
                {
                    self.skip_block_comment();
                    self.at_line_start = false;
                }
                _ => return,
            }
        }
    }
    fn skip_block_comment(&mut self) {
        let mut depth = 0;
        while self.pos < self.bytes.len() {
            if self.peek(0) == Some(b'/') && self.peek(1) == Some(b'*') {
                depth += 1;
                self.pos += 2;
                if !self.rules.nested_comments && depth > 1 {
                    depth = 1;
                }
            } else if self.peek(0) == Some(b'*') && self.peek(1) == Some(b'/') {
                depth -= 1;
                self.pos += 2;
                if depth == 0 {
                    return;
                }
            } else {
                self.pos += 1;
            }
        }
    }
    /// Skips a quoted text that ends with `close`, where doubling it escapes it.
    fn skip_quoted(&mut self, close: u8, backslash: bool) {
        self.pos += 1;
        while let Some(byte) = self.peek(0) {
            self.pos += 1;
            if backslash && byte == b'\\' {
                self.pos += 1;
            } else if byte == close {
                if self.peek(0) == Some(close) {
                    self.pos += 1;
                } else {
                    return;
                }
            }
        }
    }
    /// `$tag$ … $tag$`; false when the `$` does not open one (a parameter such as `$1`).
    fn skip_dollar_quote(&mut self) -> bool {
        let rest = &self.text[self.pos + 1..];
        let tag_length = rest
            .bytes()
            .take_while(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
            .count();
        let tag = &rest[..tag_length];
        if !rest[tag_length..].starts_with('$') || tag.starts_with(|c: char| c.is_ascii_digit()) {
            return false;
        }
        let opening = format!("${tag}$");
        let body = self.pos + opening.len();
        self.pos = match self.text[body..].find(&opening) {
            Some(index) => body + index + opening.len(),
            None => self.text.len(),
        };
        true
    }
    /// `q'X … X'`, where X is any character and `[ ( { <` close with their pair.
    fn skip_q_quote(&mut self) {
        let opener = self.text[self.pos + 2..].chars().next().unwrap_or('\'');
        let closer = match opener {
            '[' => ']',
            '(' => ')',
            '{' => '}',
            '<' => '>',
            other => other,
        };
        let body = self.pos + 2 + opener.len_utf8();
        let end = format!("{closer}'");
        self.pos = match self.text[body..].find(&end) {
            Some(index) => body + index + end.len(),
            None => self.text.len(),
        };
    }

    /// The next token, or `None` at the end of the text.
    pub fn next_token(&mut self) -> Option<Token> {
        self.skip_trivia();
        let byte = self.peek(0)?;
        let start = self.pos;
        let line_start = self.at_line_start;
        self.at_line_start = false;
        let rules = self.rules;
        let lower = byte.to_ascii_lowercase();
        let kind = match byte {
            b'\'' => {
                self.skip_quoted(b'\'', rules.mysql);
                Kind::Quoted
            }
            b'"' => {
                self.skip_quoted(b'"', rules.mysql);
                Kind::Quoted
            }
            b'`' if rules.backticks => {
                self.skip_quoted(b'`', false);
                Kind::Quoted
            }
            b'[' if rules.brackets => {
                self.skip_quoted(b']', false);
                Kind::Quoted
            }
            b'$' if rules.dollar_quotes && self.skip_dollar_quote() => Kind::Quoted,
            b'/' if rules.mysql && self.peek(1) == Some(b'*') => {
                self.skip_block_comment();
                Kind::Quoted
            }
            // E'…' strings of PostgreSQL take backslash escapes.
            _ if lower == b'e' && rules.dollar_quotes && self.peek(1) == Some(b'\'') => {
                self.pos += 1;
                self.skip_quoted(b'\'', true);
                Kind::Quoted
            }
            _ if lower == b'q' && rules.q_quotes && self.peek(1) == Some(b'\'') => {
                self.skip_q_quote();
                Kind::Quoted
            }
            _ if is_word_byte(byte) => {
                while self.peek(0).is_some_and(is_word_byte) {
                    self.pos += 1;
                }
                Kind::Word
            }
            _ => {
                self.pos += 1;
                Kind::Symbol
            }
        };
        Some(Token {
            kind,
            start,
            end: self.pos,
            line_start,
        })
    }
}
