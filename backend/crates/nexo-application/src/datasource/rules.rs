//! What a statement may do on a connection. The rules live here, not in the interface, so
//! they hold for every client: a read-only connection runs only reads, a production one
//! asks before every write, and a write to every row, a `TRUNCATE` and a `DROP` always ask.
use super::sessions::Session;
use nexo_domain::{
    Error, Result,
    sql::{Classification, ConnectionType, Dialect, StatementKind, classify, split},
};

/// What `sql` does, read as every statement it holds: the most dangerous one decides.
/// One statement is sent at a time, but a driver might run several, and a procedure's body
/// may hold some.
pub(crate) fn classify_all(sql: &str, dialect: Dialect) -> Classification {
    let rank = |kind: StatementKind| match kind {
        StatementKind::Read => 0,
        StatementKind::Transaction | StatementKind::Session => 1,
        StatementKind::Write => 2,
        StatementKind::Structure => 3,
    };
    let mut all = classify("", dialect);
    for statement in split(sql, dialect) {
        let one = classify(&statement.text, dialect);
        if rank(one.kind) > rank(all.kind) {
            all.kind = one.kind;
        }
        all.missing_where |= one.missing_where;
        all.truncate |= one.truncate;
        all.drops |= one.drops;
        for name in one.drop {
            if !all.drop.contains(&name) {
                all.drop.push(name);
            }
        }
    }
    all
}

fn refused(message: impl Into<String>) -> Error {
    Error::Validation(message.into())
}

/// Refuses a statement the session may not run, or that needs a confirmation it lacks.
pub(crate) fn check(
    session: &Session,
    classification: &Classification,
    confirm: bool,
    confirm_name: Option<&str>,
) -> Result<()> {
    if session.read_only && !classification.allowed_read_only() {
        return Err(refused(format!(
            "The connection {} is read-only: Nexo runs only statements that read",
            session.name
        )));
    }
    if classification.drops {
        let names = classification.drop.join(", ");
        if names.is_empty() && !confirm {
            return Err(refused("Confirm the DROP: it deletes what it names"));
        }
        if !names.is_empty() && confirm_name.map(str::trim) != Some(names.as_str()) {
            return Err(refused(format!(
                "Type the name of what is dropped to confirm: {names}"
            )));
        }
    }
    if (classification.missing_where || classification.truncate) && !confirm {
        return Err(refused(
            "Confirm the statement: it changes every row of the table",
        ));
    }
    if session.kind == ConnectionType::Production && classification.writes() && !confirm {
        return Err(refused(format!(
            "The connection {} is for production: confirm the statement before it changes anything",
            session.name
        )));
    }
    Ok(())
}
