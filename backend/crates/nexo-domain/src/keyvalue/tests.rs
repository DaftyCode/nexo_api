use super::*;

fn args(line: &str) -> Vec<String> {
    line.split_whitespace().map(str::to_owned).collect()
}

#[test]
fn reads_are_a_closed_list_and_anything_else_writes() {
    for (line, kind) in [
        ("get user:1", CommandKind::Read),
        ("HGETALL h", CommandKind::Read),
        ("scan 0 MATCH user:* COUNT 100", CommandKind::Read),
        ("config get maxmemory", CommandKind::Read),
        ("XINFO STREAM s", CommandKind::Read),
        ("set k v", CommandKind::Write),
        ("EVAL \"return 1\" 0", CommandKind::Write),
        ("CONFIG SET maxmemory 1", CommandKind::Write),
        ("SOMETHING.NEW x", CommandKind::Write),
        ("", CommandKind::Write),
    ] {
        assert_eq!(classify_command(&args(line)).kind, kind, "{line}");
    }
}

#[test]
fn dangerous_commands_are_named_with_their_subcommand() {
    for (line, name, dangerous) in [
        ("flushdb", "FLUSHDB", true),
        ("FLUSHALL ASYNC", "FLUSHALL", true),
        ("config set maxmemory 1", "CONFIG SET", true),
        ("CONFIG GET *", "CONFIG GET", false),
        ("debug sleep 0", "DEBUG SLEEP", true),
        ("client kill id 4", "CLIENT KILL", true),
        ("client list", "CLIENT LIST", false),
        ("del k", "DEL", false),
    ] {
        let class = classify_command(&args(line));
        assert_eq!(
            (class.name.as_str(), class.dangerous),
            (name, dangerous),
            "{line}"
        );
    }
    let subscribe = classify_command(&args("SUBSCRIBE news"));
    assert!(subscribe.refused.unwrap().contains("realtime panel"));
    assert!(classify_command(&args("GET k")).refused.is_none());
}

#[test]
fn a_console_line_is_split_as_redis_cli_splits_it() {
    let text = |line| {
        split_command(line).map(|args| {
            args.into_iter()
                .map(|arg| String::from_utf8_lossy(&arg).into_owned())
                .collect::<Vec<_>>()
        })
    };
    assert_eq!(
        text(r#"SET "a key" 'it\'s' "line\nnext""#).unwrap(),
        ["SET", "a key", "it's", "line\nnext"]
    );
    assert_eq!(text("  GET   k  ").unwrap(), ["GET", "k"]);
    assert_eq!(split_command(r#"SET k "\x00\xff""#).unwrap()[2], [0, 255]);
    assert_eq!(text("ECHO ñ").unwrap(), ["ECHO", "ñ"]);
    assert!(text(r#"SET k "open"#).is_none());
    assert!(text(r#"SET k "a"b"#).is_none());
    assert!(text("").unwrap().is_empty());
}
