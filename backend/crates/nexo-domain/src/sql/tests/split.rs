use super::super::*;

fn texts(script: &str, dialect: Dialect) -> Vec<String> {
    split(script, dialect)
        .into_iter()
        .map(|statement| statement.text)
        .collect()
}

/// A statement goes from its first word to its last one: comments before and after it are
/// not sent, comments inside it (optimizer hints) are.
#[test]
fn splits_by_the_delimiter_but_not_inside_strings_names_or_comments() {
    let script = "select 'a;b', \"c;d\" from t; -- one; two\nselect 2 /* ; */;\n\n  ;  select 3";
    assert_eq!(
        texts(script, Dialect::Ansi),
        ["select 'a;b', \"c;d\" from t", "select 2", "select 3"]
    );
    // Statements with only comments or nothing are left out.
    assert!(texts("-- nothing\n/* at all */ ;;", Dialect::Ansi).is_empty());
    assert_eq!(
        texts("select 'it''s; fine'", Dialect::Ansi),
        ["select 'it''s; fine'"]
    );
    assert_eq!(
        texts("select /*+ index(t) */ * from t -- why\n;", Dialect::PlSql),
        ["select /*+ index(t) */ * from t"]
    );
    // MySQL runs what is inside /*! … */: it is not a comment.
    assert_eq!(
        texts("/*!40101 SET NAMES utf8 */;\nselect 1;", Dialect::MySql),
        ["/*!40101 SET NAMES utf8 */", "select 1"]
    );
}

#[test]
fn postgresql_dollar_quotes_nested_comments_and_escape_strings() {
    let script = "create function f() returns int as $$\nbegin\n  return 1;\nend;\n$$ language plpgsql;\n\
        do $body$ begin perform 1; end $body$;\n\
        select $1, e'a\\';b';\n\
        /* outer /* inner; */ still; */ select 4;";
    assert_eq!(
        texts(script, Dialect::PostgreSql),
        [
            "create function f() returns int as $$\nbegin\n  return 1;\nend;\n$$ language plpgsql",
            "do $body$ begin perform 1; end $body$",
            "select $1, e'a\\';b'",
            "select 4",
        ]
    );
}

#[test]
fn mysql_delimiter_hash_comments_backticks_and_backslash_escapes() {
    let script = "select `a;b`, 'x\\';y' # not; here\n;\n\
        DELIMITER $$\n\
        create procedure p()\nbegin\n  select 1;\n  select 2;\nend$$\n\
        DELIMITER ;\n\
        call p();";
    assert_eq!(
        texts(script, Dialect::MySql),
        [
            "select `a;b`, 'x\\';y'",
            "create procedure p()\nbegin\n  select 1;\n  select 2;\nend",
            "call p()",
        ]
    );
}

#[test]
fn sql_server_batches_blocks_and_procedures() {
    let script = "select [a;b] from t;\n\
        IF 1 = 1\nBEGIN\n  print 'x';\n  select CASE WHEN 1 = 1 THEN 1 ELSE 2 END;\nEND;\n\
        BEGIN TRANSACTION;\n\
        GO\n\
        create procedure dbo.p as\nbegin\n  select 1;\n  select 2;\nend\n\
        go 2\n\
        select 3";
    assert_eq!(
        texts(script, Dialect::TSql),
        [
            "select [a;b] from t",
            "IF 1 = 1\nBEGIN\n  print 'x';\n  select CASE WHEN 1 = 1 THEN 1 ELSE 2 END;\nEND",
            "BEGIN TRANSACTION",
            "create procedure dbo.p as\nbegin\n  select 1;\n  select 2;\nend",
            "select 3",
        ]
    );
    // GO only counts alone on its line.
    assert_eq!(
        texts("select 1 as go;\nselect 'GO'", Dialect::TSql).len(),
        2
    );
}

#[test]
fn oracle_blocks_end_with_a_slash() {
    let script = "select 1 from dual;\n\
        create or replace procedure p is\nbegin\n  null;\n  dbms_output.put_line('a;b');\nend;\n/\n\
        declare\n  x number;\nbegin\n  x := 1;\nend;\n/\n\
        select q'[it's; here]' from dual;";
    assert_eq!(
        texts(script, Dialect::PlSql),
        [
            "select 1 from dual",
            "create or replace procedure p is\nbegin\n  null;\n  dbms_output.put_line('a;b');\nend;",
            "declare\n  x number;\nbegin\n  x := 1;\nend;",
            "select q'[it's; here]' from dual",
        ]
    );
}

#[test]
fn positions_count_utf16_units_and_lines_as_editors_do() {
    let script = "-- año 😀\nselect 'ñ';\n\nselect 2;";
    let statements = split(script, Dialect::Ansi);
    let utf16: Vec<u16> = script.encode_utf16().collect();
    for statement in &statements {
        let text = String::from_utf16(&utf16[statement.start..statement.end]).unwrap();
        assert_eq!(text, statement.text);
    }
    assert_eq!((statements[0].line, statements[1].line), (2, 4));

    // The statement under the cursor: inside one, after one, before the first.
    let at = |offset| statement_at(&statements, offset).map(|s| s.text.as_str());
    assert_eq!(at(statements[0].start + 2), Some("select 'ñ'"));
    assert_eq!(at(statements[0].end + 2), Some("select 'ñ'"));
    assert_eq!(at(statements[1].end), Some("select 2"));
    assert_eq!(at(0), Some("select 'ñ'"));
    assert_eq!(statement_at(&[], 3), None);
}

#[test]
fn unfinished_strings_and_comments_end_with_the_script() {
    assert_eq!(
        texts("select 'open; string", Dialect::Ansi),
        ["select 'open; string"]
    );
    assert_eq!(
        texts("select 1 /* open; comment", Dialect::PostgreSql),
        ["select 1"]
    );
    assert_eq!(
        texts("select $$ open; body", Dialect::PostgreSql),
        ["select $$ open; body"]
    );
}
