//! `mysqldump`/`mariadb-dump` and `mysql`/`mariadb`. The server, the user and the password go
//! in a temporary options file, read with `--defaults-extra-file` (which must come first);
//! the database of a restore or a script is the value of `--database`, and the script is the
//! standard input. `mysqldump` takes the database and its tables as names after the options:
//! those cannot start with `-`, so that none reads as an option.
use super::{Backup, BackupFormat, Content, Invocation, TEMP, Target, Tool, invalid, plain};
use crate::{Error, Result};

/// `value` quoted for an options file: between double quotes, `\` and `"` escaped.
fn quoted(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The `[client]` options file with where and how to connect, and its argument.
fn connection(invocation: &mut Invocation, target: &Target, mariadb: bool) -> Result<()> {
    let mut lines = vec!["[client]".to_string()];
    let host = target.address.as_deref().unwrap_or(&target.host);
    lines.push(format!("host={}", quoted(host)));
    lines.push(format!("port={}", target.port));
    lines.push("protocol=TCP".into());
    for (key, value, what) in [
        ("user", target.user.as_ref(), "user"),
        ("password", target.password.as_ref(), "password"),
    ] {
        if let Some(value) = value {
            plain(value, what)?;
            lines.push(format!("{key}={}", quoted(value)));
        }
    }
    plain(&target.host, "server")?;
    // MySQL's clients take `ssl-mode`; MariaDB's have their own switches.
    match (mariadb, target.tls.as_str()) {
        (false, mode) => lines.push(format!(
            "ssl-mode={}",
            match mode {
                "disable" => "DISABLED",
                "require" => "REQUIRED",
                "verify" => "VERIFY_IDENTITY",
                _ => "PREFERRED",
            }
        )),
        (true, "disable") => lines.push("skip-ssl".into()),
        (true, "verify") => lines.extend(["ssl".into(), "ssl-verify-server-cert".into()]),
        (true, _) => lines.extend(["ssl".into(), "skip-ssl-verify-server-cert".into()]),
    }
    if let Some(ca) = &target.ca_pem {
        invocation.files.push(("ca.pem".into(), ca.clone()));
        lines.push(format!("ssl-ca={}", quoted(&format!("{TEMP}/ca.pem"))));
    }
    invocation
        .files
        .push(("client.cnf".into(), lines.join("\n") + "\n"));
    invocation
        .args
        .insert(0, format!("--defaults-extra-file={TEMP}/client.cnf"));
    Ok(())
}

/// A database or table name after the options.
fn positional(name: &str) -> Result<&str> {
    let name = super::object_name(name)?;
    if name.starts_with('-') {
        return Err(Error::Validation(format!(
            "The MySQL client cannot be given the name {name}: it starts with -"
        )));
    }
    Ok(name)
}

fn database(target: &Target) -> Result<&str> {
    target
        .database
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .ok_or_else(|| invalid("Choose the database"))
}

pub(super) fn backup(
    tool: Tool,
    target: &Target,
    backup: &Backup,
    mariadb: bool,
) -> Result<Invocation> {
    if backup.server || backup.format != BackupFormat::Plain {
        return Err(invalid(
            "MySQL and MariaDB back up a database at a time, as SQL",
        ));
    }
    if !backup.schemas.is_empty() || backup.compress.is_some() {
        return Err(invalid(
            "A MySQL backup names tables of its database, without compression",
        ));
    }
    let mut invocation = Invocation::new(tool);
    invocation.arg("--result-file", &backup.path);
    invocation.flag("--single-transaction", true);
    invocation.flag("--routines", true);
    invocation.flag("--events", true);
    invocation.flag("--verbose", true);
    invocation.flag("--no-data", backup.content == Content::Schema);
    invocation.flag("--no-create-info", backup.content == Content::Data);
    invocation.flag("--skip-extended-insert", backup.inserts);
    if !mariadb {
        // Without them MySQL 8 asks for privileges a backup does not need, and a restore on
        // another server fails over the replication ids.
        invocation.flag("--no-tablespaces", true);
        invocation.flag("--set-gtid-purged=OFF", true);
    }
    invocation
        .args
        .push(positional(database(target)?)?.to_string());
    for (_, table) in &backup.tables {
        invocation.args.push(positional(table)?.to_string());
    }
    connection(&mut invocation, target, mariadb)?;
    Ok(invocation)
}

/// A restore or a script: the file as the standard input of the client.
pub(super) fn input(
    tool: Tool,
    target: &Target,
    path: &str,
    stop_on_error: bool,
    mariadb: bool,
) -> Result<Invocation> {
    let mut invocation = Invocation::new(tool);
    invocation.arg("--database", super::object_name(database(target)?)?);
    invocation.flag("--force", !stop_on_error);
    invocation.stdin = Some(path.to_string());
    connection(&mut invocation, target, mariadb)?;
    Ok(invocation)
}
