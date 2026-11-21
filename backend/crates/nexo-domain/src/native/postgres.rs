//! `pg_dump`, `pg_dumpall`, `pg_restore` and `psql`. The server, the user and the password go
//! in libpq's environment; the database as a quoted `dbname='…'` of `--dbname`, so that a
//! name with `=` is never read as connection settings. Schemas and tables are written as
//! exact patterns (`"schema"."table"`), which match only that name.
use super::{
    Backup, BackupFormat, Content, Invocation, Restore, Script, TEMP, Target, Tool, invalid, plain,
};
use crate::Result;

/// `value` quoted for a libpq connection string.
fn conninfo(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
}

/// `name` as a pattern of `pg_dump` that matches it exactly.
fn pattern(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// The environment libpq reads to connect, never with anything the person's own
/// environment had (the adapter clears every `PG…` variable first).
fn connection(invocation: &mut Invocation, target: &Target) -> Result<()> {
    for (value, what) in [
        (Some(&target.host), "server"),
        (target.user.as_ref(), "user"),
        (target.password.as_ref(), "password"),
    ] {
        if let Some(value) = value {
            plain(value, what)?;
        }
    }
    let env = &mut invocation.env;
    env.push(("PGHOST".into(), target.host.clone()));
    if let Some(address) = &target.address {
        env.push(("PGHOSTADDR".into(), address.clone()));
    }
    env.push(("PGPORT".into(), target.port.to_string()));
    if let Some(user) = &target.user {
        env.push(("PGUSER".into(), user.clone()));
    }
    if let Some(password) = &target.password {
        env.push(("PGPASSWORD".into(), password.clone()));
    }
    let mode = match target.tls.as_str() {
        "disable" => "disable",
        "require" => "require",
        "verify" => "verify-full",
        _ => "prefer",
    };
    env.push(("PGSSLMODE".into(), mode.into()));
    if let Some(ca) = &target.ca_pem {
        invocation.files.push(("ca.pem".into(), ca.clone()));
        invocation
            .env
            .push(("PGSSLROOTCERT".into(), format!("{TEMP}/ca.pem")));
    }
    invocation.env.push(("PGAPPNAME".into(), "Nexo API".into()));
    invocation
        .env
        .push(("PGCONNECT_TIMEOUT".into(), "15".into()));
    Ok(())
}

fn database(target: &Target) -> Result<&str> {
    let name = target
        .database
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .ok_or_else(|| invalid("Choose the database"))?;
    super::object_name(name)
}

fn common(invocation: &mut Invocation, no_owner: bool, no_privileges: bool) {
    invocation.flag("--no-password", true);
    invocation.flag("--verbose", true);
    invocation.flag("--no-owner", no_owner);
    invocation.flag("--no-privileges", no_privileges);
}

pub(super) fn backup(tool: Tool, target: &Target, backup: &Backup) -> Result<Invocation> {
    let mut invocation = Invocation::new(tool);
    connection(&mut invocation, target)?;
    common(&mut invocation, backup.no_owner, backup.no_privileges);
    invocation.arg("--file", &backup.path);
    invocation.flag("--schema-only", backup.content == Content::Schema);
    invocation.flag("--data-only", backup.content == Content::Data);
    invocation.flag("--inserts", backup.inserts);
    if tool == Tool::PgDumpAll {
        if backup.format != BackupFormat::Plain {
            return Err(invalid("A backup of the whole server is plain SQL"));
        }
        let initial = target.database.as_deref().unwrap_or("postgres");
        invocation.arg(
            "--dbname",
            &format!("dbname={}", conninfo(super::object_name(initial)?)),
        );
        return Ok(invocation);
    }
    invocation.arg("--format", backup.format.name());
    if let Some(level) = backup.compress {
        if backup.format == BackupFormat::Tar {
            return Err(invalid("A tar backup cannot be compressed"));
        }
        invocation.arg("--compress", &level.to_string());
    }
    for schema in &backup.schemas {
        invocation.arg("--schema", &pattern(schema));
    }
    for (schema, table) in &backup.tables {
        let table = match schema {
            Some(schema) => format!("{}.{}", pattern(schema), pattern(table)),
            None => pattern(table),
        };
        invocation.arg("--table", &table);
    }
    invocation.arg(
        "--dbname",
        &format!("dbname={}", conninfo(database(target)?)),
    );
    Ok(invocation)
}

pub(super) fn restore(tool: Tool, target: &Target, restore: &Restore) -> Result<Invocation> {
    let archive = restore.format != BackupFormat::Plain;
    if archive != (tool == Tool::PgRestore) {
        return Err(invalid(
            "Plain SQL is restored with psql, the other formats with pg_restore",
        ));
    }
    let mut invocation = Invocation::new(tool);
    connection(&mut invocation, target)?;
    invocation.arg(
        "--dbname",
        &format!("dbname={}", conninfo(database(target)?)),
    );
    if !archive {
        if restore.clean || restore.data_only || restore.no_owner || restore.no_privileges {
            return Err(invalid(
                "A plain SQL backup is restored as it was written: its options were chosen when it was made",
            ));
        }
        invocation.flag("--no-psqlrc", true);
        invocation.flag("--no-password", true);
        invocation.arg("--set", "ON_ERROR_STOP=1");
        invocation.flag("--single-transaction", restore.single_transaction);
        invocation.arg("--file", &restore.path);
        return Ok(invocation);
    }
    common(&mut invocation, restore.no_owner, restore.no_privileges);
    invocation.flag("--clean", restore.clean);
    invocation.flag("--if-exists", restore.clean);
    invocation.flag("--data-only", restore.data_only);
    invocation.flag("--single-transaction", restore.single_transaction);
    invocation.flag("--exit-on-error", true);
    invocation.arg("--format", restore.format.name());
    // The file goes last, on its own: a whole path, which never starts with `-`.
    invocation.args.push(restore.path.clone());
    Ok(invocation)
}

pub(super) fn script(target: &Target, script: &Script) -> Result<Invocation> {
    let mut invocation = Invocation::new(Tool::Psql);
    connection(&mut invocation, target)?;
    invocation.arg(
        "--dbname",
        &format!("dbname={}", conninfo(database(target)?)),
    );
    invocation.flag("--no-psqlrc", true);
    invocation.flag("--no-password", true);
    if script.stop_on_error {
        invocation.arg("--set", "ON_ERROR_STOP=1");
    }
    invocation.arg("--file", &script.path);
    Ok(invocation)
}
