use super::*;
use serde_json::{Value, json};

/// A whole path of this platform.
fn file(name: &str) -> String {
    std::env::temp_dir().join(name).display().to_string()
}

fn target(database: &str) -> Target {
    Target {
        host: "db.example.com".into(),
        port: 5432,
        address: None,
        user: Some("ana".into()),
        password: Some("s3cr\"et\\".into()),
        database: Some(database.into()),
        tls: "verify".into(),
        ca_pem: None,
    }
}

fn backup_of(options: Value) -> Backup {
    let mut options = options;
    options["path"] = json!(file("shop.dump"));
    Backup::read(&options).unwrap()
}

#[test]
fn pg_dump_gets_closed_options_and_exact_patterns_and_no_secret_in_its_arguments() {
    let backup = backup_of(json!({
        "format": "custom", "compress": 6, "noOwner": true, "inserts": true, "content": "data",
        "schemas": ["sales", "a\"b"],
        "tables": [{"schema": "public", "name": "my table"}, "--help", {"name": "x;rm -rf /"}],
    }));
    let invocation =
        super::backup(Tool::PgDump, &target("shop=1 host=evil"), &backup, false).unwrap();
    assert_eq!(
        invocation.args,
        [
            "--no-password",
            "--verbose",
            "--no-owner",
            &format!("--file={}", file("shop.dump")),
            "--data-only",
            "--inserts",
            "--format=custom",
            "--compress=6",
            "--schema=\"sales\"",
            "--schema=\"a\"\"b\"",
            "--table=\"public\".\"my table\"",
            "--table=\"--help\"",
            "--table=\"x;rm -rf /\"",
            "--dbname=dbname='shop=1 host=evil'",
        ]
    );
    // Every argument is an option of Nexo's with its value: none is free text.
    assert!(invocation.args.iter().all(|arg| arg.starts_with("--")));
    assert!(invocation.args.iter().all(|arg| !arg.contains("s3cr")));
    let env: Vec<&str> = invocation.env.iter().map(|(key, _)| key.as_str()).collect();
    assert_eq!(
        env,
        [
            "PGHOST",
            "PGPORT",
            "PGUSER",
            "PGPASSWORD",
            "PGSSLMODE",
            "PGAPPNAME",
            "PGCONNECT_TIMEOUT"
        ]
    );
    assert!(
        invocation
            .env
            .contains(&("PGSSLMODE".into(), "verify-full".into()))
    );
}

#[test]
fn restores_and_scripts_name_their_file_whole_and_their_database_quoted() {
    let mut pinned = target("o'neil\\db");
    pinned.address = Some("10.0.0.5".into());
    pinned.ca_pem = Some("-----BEGIN CERTIFICATE-----".into());
    let archive = Restore::read(
        &json!({"path": file("b.tar"), "format": "tar", "clean": true, "singleTransaction": true}),
    )
    .unwrap();
    let invocation = restore(Tool::PgRestore, &pinned, &archive, false).unwrap();
    assert_eq!(
        invocation.args.first().unwrap(),
        "--dbname=dbname='o\\'neil\\\\db'"
    );
    assert_eq!(invocation.args.last().unwrap(), &file("b.tar"));
    for flag in [
        "--clean",
        "--if-exists",
        "--single-transaction",
        "--exit-on-error",
        "--format=tar",
    ] {
        assert!(invocation.args.iter().any(|arg| arg == flag), "{flag}");
    }
    assert!(
        invocation
            .env
            .contains(&("PGHOSTADDR".into(), "10.0.0.5".into()))
    );
    assert!(
        invocation
            .env
            .contains(&("PGSSLROOTCERT".into(), format!("{TEMP}/ca.pem")))
    );
    assert_eq!(invocation.files[0].0, "ca.pem");
    // Plain SQL goes to psql, which stops at the first error.
    let plain = Restore::read(&json!({"path": file("b.sql")})).unwrap();
    assert!(restore(Tool::PgRestore, &pinned, &plain, false).is_err());
    let psql = restore(Tool::Psql, &pinned, &plain, false).unwrap();
    assert!(psql.args.contains(&"--set=ON_ERROR_STOP=1".to_string()));
    assert!(psql.args.contains(&format!("--file={}", file("b.sql"))));
    let script = Script::read(&json!({"path": file("big.sql"), "stopOnError": false})).unwrap();
    let run = super::script(Tool::Psql, &pinned, &script, false).unwrap();
    assert!(!run.args.iter().any(|arg| arg.contains("ON_ERROR_STOP")));
}

#[test]
fn mysql_reads_its_connection_from_a_private_file_and_refuses_names_that_read_as_options() {
    let mut mysql = target("shop");
    mysql.port = 3306;
    let backup = backup_of(json!({"tables": ["order items", "a-b"], "content": "schema"}));
    let invocation = super::backup(Tool::MysqlDump, &mysql, &backup, false).unwrap();
    assert_eq!(
        invocation.args[0],
        format!("--defaults-extra-file={TEMP}/client.cnf")
    );
    assert_eq!(
        invocation.args[invocation.args.len() - 3..],
        ["shop", "order items", "a-b"]
    );
    assert!(invocation.args.contains(&"--no-data".to_string()));
    assert!(
        invocation
            .args
            .contains(&"--set-gtid-purged=OFF".to_string())
    );
    assert!(invocation.args.iter().all(|arg| !arg.contains("s3cr")));
    let (name, options) = &invocation.files[0];
    assert_eq!(name, "client.cnf");
    assert_eq!(
        options,
        "[client]\nhost=\"db.example.com\"\nport=3306\nprotocol=TCP\nuser=\"ana\"\npassword=\"s3cr\\\"et\\\\\"\nssl-mode=VERIFY_IDENTITY\n"
    );
    let hostile = backup_of(json!({"tables": ["--result-file=/etc/passwd"]}));
    let error = super::backup(Tool::MysqlDump, &mysql, &hostile, false).unwrap_err();
    assert!(error.to_string().contains("starts with -"));
    // MariaDB's clients have other TLS switches.
    let restore = Restore::read(&json!({"path": file("b.sql")})).unwrap();
    let maria = super::restore(Tool::Mariadb, &mysql, &restore, true).unwrap();
    assert_eq!(maria.stdin.as_deref(), Some(file("b.sql").as_str()));
    assert!(maria.args.contains(&"--database=shop".to_string()));
    assert!(maria.files[0].1.contains("ssl\nssl-verify-server-cert\n"));
    for (options, message) in [
        (json!({"format": "custom"}), "a database at a time"),
        (json!({"server": true}), "a database at a time"),
        (json!({"compress": 3}), "without compression"),
    ] {
        let error = super::backup(Tool::MysqlDump, &mysql, &backup_of(options), false).unwrap_err();
        assert!(error.to_string().contains(message), "{error}");
    }
}

#[test]
fn options_names_and_paths_are_checked_before_anything_runs() {
    for (options, message) in [
        (json!({"path": "relative.sql"}), "whole path"),
        (json!({"path": "-rf"}), "whole path"),
        (json!({"path": file("a\nb.sql")}), "line breaks"),
        (
            json!({"path": file("a.sql"), "format": "zip"}),
            "plain SQL, custom",
        ),
        (json!({"path": file("a.sql"), "compress": 12}), "0 to 9"),
        (
            json!({"path": file("a.sql"), "content": "some"}),
            "everything",
        ),
        (json!({"path": file("a.sql"), "tables": [""]}), "not valid"),
        (
            json!({"path": file("a.sql"), "schemas": ["a\u{0}b"]}),
            "control characters",
        ),
    ] {
        let error = Backup::read(&options).unwrap_err();
        assert!(error.to_string().contains(message), "{options}: {error}");
    }
    let mut broken = target("shop");
    broken.password = Some("line\nbreak".into());
    let backup = backup_of(json!({}));
    assert!(super::backup(Tool::PgDump, &broken, &backup, false).is_err());
    let server = backup_of(json!({"server": true, "format": "custom"}));
    assert!(super::backup(Tool::PgDumpAll, &target("postgres"), &server, false).is_err());
    let tar = backup_of(json!({"format": "tar", "compress": 1}));
    assert!(super::backup(Tool::PgDump, &target("shop"), &tar, false).is_err());
    assert_eq!(
        candidates("postgres", Need::BackupServer).unwrap(),
        [Tool::PgDumpAll]
    );
    assert_eq!(
        candidates("mysql", Need::Script).unwrap(),
        [Tool::Mysql, Tool::Mariadb]
    );
    assert!(candidates("sqlite", Need::Backup).is_err());
    assert!(candidates("mysql", Need::RestoreArchive).is_err());
    assert_eq!(Tool::parse("mariadb-dump"), Some(Tool::MariadbDump));
    assert_eq!(Tool::parse("sh"), None);
}
