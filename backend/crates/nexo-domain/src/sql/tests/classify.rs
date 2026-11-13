use super::super::*;

fn kind(statement: &str) -> StatementKind {
    classify(statement, Dialect::PostgreSql).kind
}

#[test]
fn tells_reads_from_writes_structure_transactions_and_session() {
    use StatementKind::*;
    for (statement, expected) in [
        ("select * from orders", Read),
        ("  SELECT 1", Read),
        (
            "with recent as (select * from orders) select * from recent",
            Read,
        ),
        (
            "with gone as (delete from orders returning *) select * from gone",
            Write,
        ),
        ("values (1), (2)", Read),
        ("show search_path", Read),
        ("explain select * from orders", Read),
        ("explain (analyze) delete from orders", Write),
        ("table orders", Read),
        ("select * into backup from orders", Write),
        ("select (select 1 into x) from t", Read),
        ("insert into orders values (1)", Write),
        ("update orders set total = 1 where id = 1", Write),
        (
            "merge into a using b on a.id = b.id when matched then delete",
            Write,
        ),
        ("copy orders from stdin", Write),
        ("call refresh_totals()", Write),
        ("do $$ begin perform 1; end $$", Write),
        ("create table t (id int)", Structure),
        ("alter table t add column x int", Structure),
        ("drop table t", Structure),
        ("truncate t", Structure),
        ("grant select on t to ana", Structure),
        ("vacuum", Structure),
        ("begin", Transaction),
        ("commit", Transaction),
        ("rollback to savepoint a", Transaction),
        ("set search_path = shop", Session),
        ("use shop", Session),
        ("set transaction read write", Write),
        ("set default_transaction_read_only = off", Write),
        (
            "set session characteristics as transaction read write",
            Write,
        ),
        ("frobnicate everything", Write),
        ("-- only a comment", Read),
        ("", Read),
    ] {
        assert_eq!(kind(statement), expected, "{statement}");
    }
}

#[test]
fn dialects_read_their_own_words() {
    let of = |statement, dialect| classify(statement, dialect).kind;
    assert_eq!(
        of("begin transaction", Dialect::TSql),
        StatementKind::Transaction
    );
    assert_eq!(
        of("begin print 'x' end", Dialect::TSql),
        StatementKind::Write
    );
    assert_eq!(of("begin null; end;", Dialect::PlSql), StatementKind::Write);
    assert_eq!(of("exec dbo.p", Dialect::TSql), StatementKind::Write);
    assert_eq!(
        of("select `a` from `t`", Dialect::MySql),
        StatementKind::Read
    );
    assert_eq!(
        of("pragma table_info(t)", Dialect::Sqlite),
        StatementKind::Read
    );
    assert_eq!(
        of("pragma foreign_keys = on", Dialect::Sqlite),
        StatementKind::Write
    );
    // A quoted name is never read as a keyword.
    assert_eq!(
        of("select \"delete\" from t", Dialect::PostgreSql),
        StatementKind::Read
    );
}

#[test]
fn finds_the_statements_that_need_a_confirmation() {
    let check = |statement: &str| classify(statement, Dialect::PostgreSql);
    assert!(check("delete from orders").missing_where);
    assert!(check("UPDATE orders SET total = 0").missing_where);
    assert!(check("update orders set total = (select max(x) from y where y.id = 1)").missing_where);
    assert!(!check("delete from orders where id = 1").missing_where);
    assert!(!check("update orders set total = 0 where id in (select id from x)").missing_where);
    assert!(check("with x as (select 1) delete from orders").missing_where);
    assert!(!check("select * from orders").missing_where);
    assert!(check("truncate table orders").truncate);
    assert!(!check("delete from orders where true").truncate);

    let dropped = |statement: &str| check(statement).drop;
    assert_eq!(dropped("drop table orders"), ["orders"]);
    assert_eq!(
        dropped("DROP TABLE IF EXISTS shop.\"Orders\" CASCADE"),
        ["Orders"]
    );
    assert_eq!(
        dropped("drop materialized view concurrently a, b.c"),
        ["a", "c"]
    );
    assert_eq!(
        classify("drop table [dbo].[Orders]", Dialect::TSql).drop,
        ["Orders"]
    );
    assert!(check("drop table orders").drops);
    assert!(check("alter table t drop column x").drop.is_empty());
    assert!(!check("alter table t drop column x").drops);
}

#[test]
fn what_a_read_only_connection_may_run() {
    let allowed = |statement| classify(statement, Dialect::PostgreSql).allowed_read_only();
    assert!(allowed("select 1"));
    assert!(allowed("begin"));
    assert!(allowed("set search_path = shop"));
    assert!(!allowed("insert into t values (1)"));
    assert!(!allowed("set transaction read write"));
    assert!(!allowed("create table t (id int)"));
    assert!(!allowed("anything unknown"));
}
