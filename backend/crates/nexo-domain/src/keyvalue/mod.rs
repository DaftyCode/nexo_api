//! What a command of a key-value store (Redis, Valkey) does, read from its name: the rules of
//! a connection hold for the console as they do for SQL (DB-35). The commands that only read
//! are a closed list: any other one, known or not, counts as a write. The dangerous ones
//! (they empty a database, stop or reconfigure the server) are confirmed by typing them.
use serde::Serialize;

#[cfg(test)]
mod tests;
mod words;

use words::{CONTAINERS, DANGEROUS, READS, REFUSED};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandKind {
    Read,
    Write,
}

/// A command as the rules see it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandClass {
    /// Its name in upper case, with its subcommand when it has one: `CONFIG SET`.
    pub name: String,
    pub kind: CommandKind,
    /// It must be confirmed by typing its name.
    pub dangerous: bool,
    /// The console never sends it: why, as a message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refused: Option<String>,
}

impl CommandClass {
    pub fn writes(&self) -> bool {
        self.kind == CommandKind::Write
    }
}

/// The name of a command: its first word, and its second one for the commands that are
/// families of subcommands (`CONFIG GET`, `CLIENT KILL`).
pub fn command_name(args: &[String]) -> String {
    let first = args.first().map(|word| word.trim().to_ascii_uppercase());
    let first = first.unwrap_or_default();
    match args.get(1) {
        Some(second) if CONTAINERS.contains(&first.as_str()) => {
            format!("{first} {}", second.trim().to_ascii_uppercase())
        }
        _ => first,
    }
}

/// What a command does.
pub fn classify_command(args: &[String]) -> CommandClass {
    let name = command_name(args);
    let first = name.split(' ').next().unwrap_or_default();
    let reads = READS.contains(&name.as_str())
        // A family whose every subcommand only reads.
        || matches!(first, "XINFO" | "OBJECT" | "LATENCY" | "PUBSUB" | "COMMAND")
            && !DANGEROUS.contains(&name.as_str());
    let refused = REFUSED
        .iter()
        .find(|(command, _)| *command == first)
        .map(|(_, why)| (*why).to_owned());
    CommandClass {
        dangerous: DANGEROUS.contains(&name.as_str()) || DANGEROUS.contains(&first),
        kind: if reads {
            CommandKind::Read
        } else {
            CommandKind::Write
        },
        refused,
        name,
    }
}

/// Splits a console line into its arguments as redis-cli does: by spaces, with `"…"` (and
/// its escapes `\n`, `\t`, `\"`, `\\`, `\xHH`) and `'…'` keeping theirs. `None` when a quote
/// is not closed.
pub fn split_command(line: &str) -> Option<Vec<Vec<u8>>> {
    let mut args = Vec::new();
    let mut chars = line.chars().peekable();
    loop {
        while chars.peek().is_some_and(|c| c.is_whitespace()) {
            chars.next();
        }
        let Some(&start) = chars.peek() else {
            return Some(args);
        };
        let mut arg = Vec::new();
        if start == '"' || start == '\'' {
            chars.next();
            let mut closed = false;
            while let Some(c) = chars.next() {
                if c == start {
                    closed = true;
                    break;
                }
                if c == '\\' && start == '"' {
                    match chars.next()? {
                        'n' => arg.push(b'\n'),
                        'r' => arg.push(b'\r'),
                        't' => arg.push(b'\t'),
                        'x' => {
                            let high = chars.next()?.to_digit(16)?;
                            let low = chars.next()?.to_digit(16)?;
                            arg.push((high * 16 + low) as u8);
                        }
                        other => push_char(&mut arg, other),
                    }
                } else if c == '\\' && chars.peek() == Some(&'\'') {
                    chars.next();
                    arg.push(b'\'');
                } else {
                    push_char(&mut arg, c);
                }
            }
            if !closed || chars.peek().is_some_and(|c| !c.is_whitespace()) {
                return None;
            }
        } else {
            while let Some(&c) = chars.peek() {
                if c.is_whitespace() {
                    break;
                }
                push_char(&mut arg, c);
                chars.next();
            }
        }
        args.push(arg);
    }
}

fn push_char(bytes: &mut Vec<u8>, c: char) {
    let mut buffer = [0; 4];
    bytes.extend_from_slice(c.encode_utf8(&mut buffer).as_bytes());
}
