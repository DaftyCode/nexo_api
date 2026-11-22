//! What a statement may do (DB-30). DuckDB itself reads only the files of the connection
//! (`allowed_paths`, external access off, no extension installed or loaded, its settings
//! locked); on top of that, files are never written, and no statement installs, loads,
//! attaches, copies or changes a setting.
use nexo_driver_sdk::{DriverError, Result};

/// What reads, in a connection of files.
const READS: [&str; 9] = [
    "select",
    "with",
    "from",
    "values",
    "describe",
    "show",
    "summarize",
    "explain",
    "table",
];
/// What no connection runs.
const NEVER: [&str; 11] = [
    "install",
    "load",
    "attach",
    "detach",
    "copy",
    "export",
    "import",
    "set",
    "reset",
    "pragma",
    "checkpoint",
];

/// The first word of a statement, past spaces, comments and parentheses.
fn first_word(sql: &str) -> String {
    let mut rest = sql;
    loop {
        rest = rest.trim_start_matches(|c: char| c.is_whitespace() || c == '(');
        if let Some(line) = rest.strip_prefix("--") {
            rest = line.split_once('\n').map_or("", |(_, after)| after);
        } else if let Some(block) = rest.strip_prefix("/*") {
            rest = block.split_once("*/").map_or("", |(_, after)| after);
        } else {
            break;
        }
    }
    rest.chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_ascii_lowercase()
}

/// Refuses what the connection may not run: in files, anything but reading.
pub fn check(sql: &str, files: bool) -> Result<()> {
    let word = first_word(sql);
    if NEVER.contains(&word.as_str()) {
        return Err(DriverError::permission(format!(
            "{} is not run here: Nexo reads only the files of the connection",
            word.to_uppercase()
        )));
    }
    if files && !READS.contains(&word.as_str()) {
        return Err(DriverError::permission(
            "The files of a connection are only read: export a result to write a file",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::check;

    #[test]
    fn files_are_only_read_and_nothing_is_installed_attached_or_copied() {
        for sql in [
            "SELECT 1",
            "  -- the totals\n  WITH t AS (SELECT 1) SELECT * FROM t",
            "/* x */ (SELECT 2)",
            "FROM ventas",
            "DESCRIBE ventas",
            "SUMMARIZE ventas",
        ] {
            assert!(check(sql, true).is_ok(), "{sql}");
        }
        for sql in [
            "INSERT INTO t VALUES (1)",
            "CREATE TABLE t (a int)",
            "DROP VIEW ventas",
            "update t set a = 1",
        ] {
            assert!(check(sql, true).is_err(), "{sql}");
            assert!(check(sql, false).is_ok(), "{sql}");
        }
        for sql in [
            "INSTALL httpfs",
            "LOAD httpfs",
            "ATTACH 'other.duckdb'",
            "COPY ventas TO 'out.csv'",
            "SET enable_external_access = true",
            "PRAGMA version",
            "EXPORT DATABASE 'x'",
        ] {
            let error = check(sql, false).unwrap_err();
            assert!(error.message.contains("is not run here"), "{sql}");
        }
    }
}
