//! The commands of cqlsh that set how the next statements run, which the server does not
//! know: `CONSISTENCY [level]` and `TRACING ON|OFF`. They change the session of the editor
//! and answer with a notice, as cqlsh does.
use crate::connection::consistency;
use nexo_driver_sdk::{Result, statements::Notice};
use scylla::statement::Consistency;
use std::sync::Mutex;

/// How the statements of a connection run.
#[derive(Clone, Default)]
pub(crate) struct Settings {
    /// The level of each statement; the connection's default when none.
    pub consistency: Option<Consistency>,
    pub tracing: bool,
}

pub(crate) enum Command {
    /// `CONSISTENCY` alone: says the current level.
    ShowConsistency,
    Consistency(Consistency),
    Tracing(bool),
}

/// The command a statement is, if it is one.
pub(crate) fn command(sql: &str) -> Result<Option<Command>> {
    let text = sql.trim().trim_end_matches(';').trim();
    let mut words = text.split_whitespace();
    let first = words.next().unwrap_or_default().to_ascii_uppercase();
    let rest: Vec<&str> = words.collect();
    Ok(match (first.as_str(), rest.as_slice()) {
        ("CONSISTENCY", []) => Some(Command::ShowConsistency),
        ("CONSISTENCY", [level]) => Some(Command::Consistency(consistency(level)?)),
        ("TRACING", [flag]) if flag.eq_ignore_ascii_case("on") => Some(Command::Tracing(true)),
        ("TRACING", [flag]) if flag.eq_ignore_ascii_case("off") => Some(Command::Tracing(false)),
        _ => None,
    })
}

/// Applies a command to the settings, with what it says.
pub(crate) fn apply(settings: &Mutex<Settings>, default: Consistency, command: Command) -> Notice {
    let mut settings = settings.lock().unwrap();
    let message = match command {
        Command::ShowConsistency => format!(
            "Current consistency level is {}.",
            name(settings.consistency.unwrap_or(default))
        ),
        Command::Consistency(level) => {
            settings.consistency = Some(level);
            format!("Consistency level set to {}.", name(level))
        }
        Command::Tracing(true) => {
            settings.tracing = true;
            "Now tracing requests.".to_owned()
        }
        Command::Tracing(false) => {
            settings.tracing = false;
            "Disabled tracing.".to_owned()
        }
    };
    Notice {
        severity: "info".into(),
        message,
    }
}

/// A level as CQL writes it: `LOCAL_QUORUM`.
pub(crate) fn name(level: Consistency) -> String {
    let debug = format!("{level:?}");
    let mut out = String::new();
    for (at, letter) in debug.chars().enumerate() {
        if letter.is_ascii_uppercase() && at > 0 {
            out.push('_');
        }
        out.push(letter.to_ascii_uppercase());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_commands_of_cqlsh_are_recognised() {
        assert!(matches!(
            command("consistency local_quorum;").unwrap(),
            Some(Command::Consistency(Consistency::LocalQuorum))
        ));
        assert!(matches!(
            command(" CONSISTENCY ").unwrap(),
            Some(Command::ShowConsistency)
        ));
        assert!(matches!(
            command("tracing On").unwrap(),
            Some(Command::Tracing(true))
        ));
        assert!(command("CONSISTENCY maybe").is_err());
        assert!(command("SELECT * FROM t").unwrap().is_none());
        assert!(command("TRACING").unwrap().is_none());
        let settings = Mutex::new(Settings::default());
        let said = apply(&settings, Consistency::LocalOne, Command::ShowConsistency);
        assert_eq!(said.message, "Current consistency level is LOCAL_ONE.");
        apply(
            &settings,
            Consistency::One,
            Command::Consistency(Consistency::EachQuorum),
        );
        assert_eq!(
            settings.lock().unwrap().consistency,
            Some(Consistency::EachQuorum)
        );
        apply(&settings, Consistency::One, Command::Tracing(true));
        assert!(settings.lock().unwrap().tracing);
        assert_eq!(name(Consistency::Quorum), "QUORUM");
    }
}
