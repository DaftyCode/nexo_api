//! Paths in a JSON document, as JSONPath writes them (`$.items[2].name`,
//! `$["content-type"]`), and the patterns that name some of them to leave them out of a
//! comparison.
use crate::{Error, Result};

/// A step of a path: a field of an object or an item of an array.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Segment {
    Key(String),
    Index(usize),
}

/// Whether a field can follow a dot: letters, digits, `_` and `$`, not starting with a digit.
fn plain(key: &str) -> bool {
    let mut chars = key.chars();
    chars
        .next()
        .is_some_and(|first| first.is_alphabetic() || first == '_' || first == '$')
        && chars.all(|c| c.is_alphanumeric() || c == '_' || c == '$')
}

/// A path as JSONPath writes it: `$` is the document, `.name` a field, `[2]` an item and
/// `["content-type"]` a field that cannot follow a dot.
pub fn json_path(path: &[Segment]) -> String {
    let mut text = String::from("$");
    for segment in path {
        match segment {
            Segment::Index(index) => text.push_str(&format!("[{index}]")),
            Segment::Key(key) if plain(key) => {
                text.push('.');
                text.push_str(key);
            }
            Segment::Key(key) => {
                let quoted = serde_json::to_string(key).unwrap_or_default();
                text.push_str(&format!("[{quoted}]"));
            }
        }
    }
    text
}

/// A step of a pattern.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Step {
    Key(String),
    Index(usize),
    /// `*`: any field or item.
    Any,
    /// `[*]`: any item.
    AnyItem,
    /// `**`: any number of levels, none included.
    AnyDepth,
}

/// A path to leave out of a comparison, with everything under it. `updatedAt` names that
/// field at any depth and `$.meta.id` only the one under the document; `*` is any field or
/// item, `[*]` any item and `**` any number of levels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pattern(Vec<Step>);

impl Pattern {
    pub fn parse(text: &str) -> Result<Self> {
        let invalid = || Error::Validation(format!("Invalid path to ignore: {text}"));
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Err(invalid());
        }
        let mut steps = Vec::new();
        // `$` followed by nothing, a dot or a bracket is the document; `$oid` is a field.
        let anchored = trimmed
            .strip_prefix('$')
            .filter(|rest| rest.is_empty() || rest.starts_with(['.', '[']));
        let rest = match anchored {
            Some(rest) => rest.to_string(),
            None => {
                steps.push(Step::AnyDepth);
                if trimmed.starts_with('[') {
                    trimmed.to_string()
                } else {
                    format!(".{trimmed}")
                }
            }
        };
        let mut chars = rest.chars().peekable();
        while let Some(start) = chars.next() {
            let step = match start {
                '.' => {
                    let mut key = String::new();
                    while let Some(&next) = chars.peek() {
                        if next == '.' || next == '[' {
                            break;
                        }
                        key.push(next);
                        chars.next();
                    }
                    match key.as_str() {
                        // Other fields are written in brackets: `["a]"]`.
                        "" => return Err(invalid()),
                        _ if key.contains(']') => return Err(invalid()),
                        "*" => Step::Any,
                        "**" => Step::AnyDepth,
                        _ => Step::Key(key),
                    }
                }
                '[' => bracket(&mut chars).ok_or_else(invalid)?,
                _ => return Err(invalid()),
            };
            // `**.**` is one `**`.
            if !(step == Step::AnyDepth && steps.last() == Some(&Step::AnyDepth)) {
                steps.push(step);
            }
        }
        Ok(Self(steps))
    }

    /// Whether the pattern names `path` or one of the fields or items that contain it.
    pub fn covers(&self, path: &[Segment]) -> bool {
        matches(&self.0, path)
    }
}

/// What a bracket holds, after `[`: an index, `*`, or a field in quotes.
fn bracket(chars: &mut std::iter::Peekable<std::str::Chars>) -> Option<Step> {
    let step = match chars.peek().copied()? {
        quote @ ('"' | '\'') => {
            chars.next();
            let mut key = String::new();
            loop {
                match chars.next()? {
                    '\\' => key.push(chars.next()?),
                    c if c == quote => break,
                    c => key.push(c),
                }
            }
            Step::Key(key)
        }
        _ => {
            let mut inside = String::new();
            while let Some(&next) = chars.peek() {
                if next == ']' {
                    break;
                }
                inside.push(next);
                chars.next();
            }
            match inside.trim() {
                "*" => Step::AnyItem,
                index => Step::Index(index.parse().ok()?),
            }
        }
    };
    (chars.next()? == ']').then_some(step)
}

fn matches(steps: &[Step], path: &[Segment]) -> bool {
    let Some((step, rest)) = steps.split_first() else {
        return true;
    };
    if *step == Step::AnyDepth {
        return (0..=path.len()).any(|skip| matches(rest, &path[skip..]));
    }
    let Some((segment, tail)) = path.split_first() else {
        return false;
    };
    let accepted = match (step, segment) {
        (Step::Any, _) | (Step::AnyItem, Segment::Index(_)) => true,
        (Step::Key(name), Segment::Key(key)) => name == key,
        (Step::Index(wanted), Segment::Index(index)) => wanted == index,
        _ => false,
    };
    accepted && matches(rest, tail)
}
