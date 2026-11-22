use super::parse;
use serde_json::json;

fn model(sql: &str, dialect: &str) -> serde_json::Value {
    let answer = parse(sql, dialect).unwrap();
    assert!(answer["unsupported"].is_null(), "{sql}: {answer}");
    answer["model"].clone()
}

#[test]
fn a_select_with_joins_conditions_groups_and_a_page_is_read_whole() {
    let read = model(
        "SELECT o.id, c.name AS customer, count(*) AS n, sum(o.total) \
         FROM public.orders o \
         JOIN customers AS c ON c.id = o.customer_id AND c.region = o.region \
         LEFT JOIN \"Order Lines\" l ON l.order_id = o.id \
         WHERE o.status = 'it''s paid' AND (o.total > 10.5 OR o.total < -1) \
           AND c.name LIKE 'A%' AND o.kind IN ('a', 'b') AND o.at BETWEEN '2024-01-01' AND now() \
           AND o.note IS NULL \
         GROUP BY o.id, c.name HAVING count(*) >= 2 \
         ORDER BY n DESC, o.id LIMIT 50 OFFSET 10",
        "postgresql",
    );
    assert_eq!(
        read["tables"],
        json!([
            {"path": ["public", "orders"], "alias": "o"},
            {"path": ["customers"], "alias": "c"},
            {"path": ["Order Lines"], "alias": "l"},
        ])
    );
    assert_eq!(
        read["joins"],
        json!([
            {"table": 1, "kind": "inner", "on": [
                {"left": "c.id", "operator": "=", "right": "o.customer_id"},
                {"left": "c.region", "operator": "=", "right": "o.region"},
            ]},
            {"table": 2, "kind": "left", "on": [
                {"left": "l.order_id", "operator": "=", "right": "o.id"},
            ]},
        ])
    );
    assert_eq!(
        read["columns"],
        json!([
            {"expression": "o.id", "alias": "", "aggregate": ""},
            {"expression": "c.name", "alias": "customer", "aggregate": ""},
            {"expression": "*", "alias": "n", "aggregate": "count"},
            {"expression": "o.total", "alias": "", "aggregate": "sum"},
        ])
    );
    let conditions = &read["where"];
    assert_eq!(conditions["match"], "all");
    assert_eq!(
        conditions["items"][0],
        json!({"column": "o.status", "operator": "=", "values": [{"text": "it's paid", "kind": "text"}]})
    );
    assert_eq!(
        conditions["items"][1],
        json!({"match": "any", "items": [
            {"column": "o.total", "operator": ">", "values": [{"text": "10.5", "kind": "number"}]},
            {"column": "o.total", "operator": "<", "values": [{"text": "-1", "kind": "number"}]},
        ]})
    );
    assert_eq!(conditions["items"][2]["operator"], "like");
    assert_eq!(
        conditions["items"][3]["values"].as_array().unwrap().len(),
        2
    );
    assert_eq!(
        conditions["items"][4]["values"],
        json!([{"text": "2024-01-01", "kind": "text"}, {"text": "now()", "kind": "expression"}])
    );
    assert_eq!(conditions["items"][5]["operator"], "is null");
    assert_eq!(read["groupBy"], json!(["o.id", "c.name"]));
    assert_eq!(
        read["having"]["items"][0],
        json!({"column": "count(*)", "operator": ">=", "values": [{"text": "2", "kind": "number"}]})
    );
    assert_eq!(
        read["orderBy"],
        json!([{"expression": "n", "descending": true}, {"expression": "o.id", "descending": false}])
    );
    assert_eq!(
        (read["limit"].clone(), read["offset"].clone()),
        (json!(50), json!(10))
    );
    assert_eq!(read["distinct"], false);
}

#[test]
fn each_dialect_gives_its_page_and_its_quoted_names() {
    let mssql = model(
        "SELECT TOP 5 [o].[id] FROM [dbo].[orders] AS [o] ORDER BY [o].[id]",
        "mssql",
    );
    assert_eq!(mssql["limit"], 5);
    assert_eq!(mssql["tables"][0]["path"], json!(["dbo", "orders"]));
    assert_eq!(mssql["columns"][0]["expression"], "[o].[id]");
    let fetch = model(
        "SELECT id FROM orders ORDER BY id OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY",
        "mssql",
    );
    assert_eq!(
        (fetch["limit"].clone(), fetch["offset"].clone()),
        (json!(10), json!(20))
    );
    let mysql = model(
        "SELECT DISTINCT `name` FROM `shop`.`people` LIMIT 10, 5",
        "mysql",
    );
    assert_eq!(mysql["distinct"], true);
    assert_eq!(
        (mysql["limit"].clone(), mysql["offset"].clone()),
        (json!(5), json!(10))
    );
    let sqlite = model(
        "SELECT p.*, count(DISTINCT p.city) FROM people p RIGHT JOIN towns t ON t.id <> p.town",
        "sqlite",
    );
    assert_eq!(sqlite["columns"][0]["expression"], "p.*");
    assert_eq!(sqlite["columns"][1]["aggregate"], "count-distinct");
    assert_eq!(sqlite["joins"][0]["kind"], "right");
}

#[test]
fn what_the_model_cannot_hold_is_named_and_never_approximated() {
    for (sql, why) in [
        (
            "SELECT * FROM t WHERE id IN (SELECT id FROM u)",
            "subqueries",
        ),
        ("SELECT (SELECT 1) FROM t", "subqueries"),
        (
            "SELECT * FROM (SELECT 1) AS x",
            "subqueries and table functions in FROM",
        ),
        (
            "SELECT * FROM t UNION SELECT * FROM u",
            "UNION, INTERSECT, EXCEPT and VALUES",
        ),
        ("WITH x AS (SELECT 1) SELECT * FROM x", "WITH"),
        (
            "SELECT row_number() OVER (ORDER BY id) FROM t",
            "window functions",
        ),
        (
            "SELECT * FROM t, u",
            "tables separated by commas: join them",
        ),
        (
            "SELECT * FROM t JOIN u USING (id)",
            "JOIN … USING and joins without ON",
        ),
        (
            "SELECT * FROM t CROSS JOIN u",
            "CROSS, APPLY, NATURAL and other joins",
        ),
        ("SELECT * FROM t WHERE NOT a = 1", "the condition NOT a = 1"),
        ("SELECT * FROM t WHERE EXISTS (SELECT 1)", "subqueries"),
        ("SELECT 1", "a SELECT without FROM"),
        ("UPDATE t SET a = 1", "statements other than SELECT"),
        (
            "SELECT 1 FROM t; SELECT 2 FROM t",
            "more than one statement",
        ),
        ("SELECT * FROM t FOR UPDATE", "FOR UPDATE and other clauses"),
        (
            "SELECT * FROM t ORDER BY a NULLS FIRST",
            "NULLS FIRST and NULLS LAST",
        ),
        (
            "SELECT * FROM t JOIN u ON t.a = u.b OR t.c = u.d",
            "the join condition t.a = u.b OR t.c = u.d",
        ),
        ("SELECT * FROM t LIMIT $1", "a LIMIT that is not a number"),
    ] {
        assert_eq!(
            parse(sql, "postgresql").unwrap()["unsupported"],
            json!(why),
            "{sql}"
        );
    }
    assert!(parse("SELEC nothing", "postgresql").is_err());
    assert!(parse(&"x".repeat(20_001), "postgresql").is_err());
}
