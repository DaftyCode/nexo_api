use super::translate;
use serde_json::{Value, json};

fn check(sql: &str, expected: Value) {
    assert_eq!(translate(sql).unwrap(), expected, "{sql}");
}

#[test]
fn simple_selects_become_finds() {
    check(
        "SELECT * FROM orders",
        json!({"kind": "find", "collection": "orders"}),
    );
    check(
        "SELECT name, address.city FROM customers WHERE age >= 18 AND city = 'Lugo' ORDER BY name DESC LIMIT 10 OFFSET 20",
        json!({"kind": "find", "collection": "customers",
               "filter": {"$and": [{"age": {"$gte": 18}}, {"city": "Lugo"}]},
               "projection": {"_id": 0, "name": 1, "address.city": 1},
               "sort": {"name": -1}, "skip": 20, "limit": 10}),
    );
    check(
        "SELECT _id, n FROM big b WHERE b.status IN ('A', 'B') OR NOT (n < 5) LIMIT 3",
        json!({"kind": "find", "collection": "big",
               "filter": {"$or": [{"status": {"$in": ["A", "B"]}}, {"$nor": [{"n": {"$lt": 5}}]}]},
               "projection": {"_id": 1, "n": 1}, "limit": 3}),
    );
}

#[test]
fn conditions_cover_the_usual_sql() {
    let filter = |condition: &str| {
        translate(&format!("SELECT * FROM t WHERE {condition}")).unwrap()["filter"].clone()
    };
    assert_eq!(filter("5 < a"), json!({"a": {"$gt": 5}}));
    assert_eq!(filter("a <> -2.5"), json!({"a": {"$ne": -2.5}}));
    assert_eq!(filter("a IS NULL"), json!({"a": null}));
    assert_eq!(filter("a IS NOT NULL"), json!({"a": {"$ne": null}}));
    assert_eq!(filter("a NOT IN (1, 2)"), json!({"a": {"$nin": [1, 2]}}));
    assert_eq!(
        filter("a BETWEEN 1 AND 9"),
        json!({"a": {"$gte": 1, "$lte": 9}})
    );
    assert_eq!(
        filter("a NOT BETWEEN 1 AND 9"),
        json!({"$or": [{"a": {"$lt": 1}}, {"a": {"$gt": 9}}]})
    );
    assert_eq!(
        filter("name LIKE 'Jo_n%'"),
        json!({"name": {"$regex": "^Jo.n.*$"}})
    );
    assert_eq!(
        filter("name ILIKE 'a.b%'"),
        json!({"name": {"$regex": "^a\\.b.*$", "$options": "i"}})
    );
    assert_eq!(
        filter("name NOT LIKE 'x%'"),
        json!({"name": {"$not": {"$regex": "^x.*$"}}})
    );
    assert_eq!(
        filter("at >= DATE '2024-01-02'"),
        json!({"at": {"$gte": {"$date": "2024-01-02T00:00:00Z"}}})
    );
    assert_eq!(
        filter("at < TIMESTAMP '2024-01-02 03:04:05'"),
        json!({"at": {"$lt": {"$date": "2024-01-02T03:04:05Z"}}})
    );
    assert_eq!(
        filter("_id = ObjectId('65A1B2C3D4E5F6A7B8C9D0E1')"),
        json!({"_id": {"$oid": "65a1b2c3d4e5f6a7b8c9d0e1"}})
    );
    assert_eq!(filter("active"), json!({"active": true}));
    assert_eq!(filter("a = b"), json!({"$expr": {"$eq": ["$a", "$b"]}}));
    assert_eq!(
        filter("big = 9007199254740993"),
        json!({"big": 9007199254740993_i64})
    );
}

#[test]
fn groups_aliases_and_joins_become_pipelines() {
    check(
        "SELECT city AS place, COUNT(*) AS n, SUM(total), AVG(total) avg FROM orders WHERE status = 'A' GROUP BY city HAVING COUNT(*) > 1 ORDER BY n DESC LIMIT 5",
        json!({"kind": "aggregate", "collection": "orders", "pipeline": [
            {"$match": {"status": "A"}},
            {"$group": {"_id": {"place": "$city"}, "n": {"$sum": 1}, "sum_total": {"$sum": "$total"}, "avg": {"$avg": "$total"}}},
            {"$project": {"_id": 0, "place": "$_id.place", "n": 1, "sum_total": 1, "avg": 1}},
            {"$match": {"n": {"$gt": 1}}},
            {"$sort": {"n": -1}},
            {"$limit": 5},
        ]}),
    );
    check(
        "SELECT COUNT(email), MAX(age) FROM people",
        json!({"kind": "aggregate", "collection": "people", "pipeline": [
            {"$group": {"_id": null, "count_email": {"$sum": {"$cond": [{"$gt": ["$email", null]}, 1, 0]}}, "max_age": {"$max": "$age"}}},
            {"$project": {"_id": 0, "count_email": 1, "max_age": 1}},
        ]}),
    );
    check(
        "SELECT o.sku, c.name AS customer FROM orders o LEFT JOIN customers c ON o.customer = c._id WHERE c.city = 'Lugo' ORDER BY customer",
        json!({"kind": "aggregate", "collection": "orders", "pipeline": [
            {"$lookup": {"from": "customers", "localField": "customer", "foreignField": "_id", "as": "c"}},
            {"$unwind": {"path": "$c", "preserveNullAndEmptyArrays": true}},
            {"$match": {"c.city": "Lugo"}},
            {"$sort": {"c.name": 1}},
            {"$project": {"_id": 0, "sku": 1, "customer": "$c.name"}},
        ]}),
    );
    let inner = translate("SELECT * FROM a JOIN b ON b.id = a.b_id").unwrap();
    assert_eq!(inner["pipeline"][0]["$lookup"]["localField"], "b_id");
    assert_eq!(
        inner["pipeline"][1]["$unwind"]["preserveNullAndEmptyArrays"],
        false
    );
}

#[test]
fn what_is_not_supported_is_named() {
    for (sql, part) in [
        ("DELETE FROM t", "Only SELECT"),
        ("UPDATE t SET a = 1", "Only SELECT"),
        ("SELECT DISTINCT a FROM t", "DISTINCT"),
        ("SELECT a FROM t UNION SELECT a FROM u", "UNION"),
        ("SELECT a + 1 FROM t", "a + 1"),
        ("SELECT UPPER(a) FROM t", "UPPER"),
        ("SELECT COUNT(DISTINCT a) FROM t", "COUNT(DISTINCT"),
        (
            "SELECT a, COUNT(*) FROM t GROUP BY b",
            "a is neither in GROUP BY",
        ),
        ("SELECT * FROM t WHERE a IN (SELECT b FROM u)", "IN"),
        ("SELECT * FROM t, u", "one collection"),
        (
            "SELECT * FROM t RIGHT JOIN u ON t.a = u.b",
            "only INNER and LEFT",
        ),
        ("SELECT * FROM t JOIN u ON t.a > u.b", "one equality"),
        ("SELECT * FROM t WHERE a LIKE b", "b is not a value"),
        ("SELECT * FROM t LIMIT -1", "LIMIT"),
        ("SELECT a FROM t HAVING a > 1", "HAVING without GROUP BY"),
        ("SELEC a", "cannot be read"),
        ("SELECT 1; SELECT 2", "one SELECT"),
    ] {
        let error = translate(sql).unwrap_err().to_string();
        assert!(error.contains(part), "{sql}: {error}");
    }
    assert!(
        translate(&"x".repeat(20_001))
            .unwrap_err()
            .to_string()
            .contains("longer")
    );
}
