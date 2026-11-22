//! `nx.sql` in the sandbox (DB-32): statements queued with their parameters bound as values
//! of the drivers, results turned into rows by column, and nothing of the connection but its
//! name.
use super::*;

#[test]
fn statements_are_queued_with_bound_parameters_and_rows_come_back_by_column() {
    let session = session();
    session
        .run(
            &[r#"
                pm.test('found', async () => {
                    const db = nx.sql('Shop');
                    const rows = await db.query('SELECT * FROM orders WHERE id = $1', [
                        42,
                        "O'Brien",
                        true,
                        null,
                        undefined,
                        1.5,
                        12345678901234567890n,
                        new Date('2024-01-02T03:04:05.006Z'),
                        nx.sql.numeric('19.99'),
                        nx.sql.bytes([1, 2, 3]),
                        nx.sql.typed('uuid', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'),
                        [1, 2],
                        { a: 1 },
                        new Uint8Array([255]),
                        Infinity,
                    ]);
                    const row = rows[0];
                    pm.environment.set('rows', rows.length);
                    pm.environment.set('truncated', rows.truncated);
                    pm.environment.set('columns', rows.columns.join(','));
                    pm.environment.set('id', row.id);
                    pm.environment.set('total', String(row.total));
                    pm.environment.set('totalKind', row.total.$t);
                    pm.environment.set('totalNumber', +row.total);
                    pm.environment.set('at', row.at.toISOString());
                    pm.environment.set('local', String(row.local));
                    pm.environment.set('uuid', row.uuid);
                    pm.environment.set('tags', row.tags.join('|'));
                    pm.environment.set('json', JSON.stringify(row));
                    pm.environment.set('cut', row.cut.truncated);
                    pm.environment.set('second', row.id_8);
                });
                nx.sql('Shop').execute('DELETE FROM orders', [], { confirm: true });
                nx.sql('Shop').execute('DROP TABLE t', [], { confirm: 't' });
            "#
            .into()],
            None,
        )
        .unwrap();
    let calls = session.take_sql().unwrap();
    assert_eq!(calls.len(), 3);
    let (id, call) = &calls[0];
    assert_eq!(call["connection"], "Shop");
    assert_eq!(call["method"], "query");
    assert_eq!(call["sql"], "SELECT * FROM orders WHERE id = $1");
    assert_eq!(call["confirm"], false);
    assert_eq!(
        call["params"],
        json!([
            42,
            "O'Brien",
            true,
            null,
            null,
            1.5,
            {"$t": "integer", "v": "12345678901234567890"},
            {"$t": "timestamptz", "v": "2024-01-02T03:04:05.006Z"},
            {"$t": "decimal", "v": "19.99"},
            {"$t": "binary", "v": "AQID"},
            {"$t": "uuid", "v": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"},
            {"$t": "array", "v": [1, 2]},
            {"$t": "json", "v": "{\"a\":1}"},
            {"$t": "binary", "v": "/w=="},
            {"$t": "float", "v": "Infinity"},
        ])
    );
    assert_eq!(calls[1].1["confirm"], true);
    assert_eq!(calls[2].1["confirm"], "t");
    session
        .deliver_sql(
            id,
            Some(&json!({
                "columns": ["id", "total", "at", "local", "uuid", "tags", "cut", "id"],
                "rows": [[
                    7,
                    {"$t": "decimal", "v": "19.99"},
                    {"$t": "timestamptz", "v": "2024-01-02T03:04:05.006Z"},
                    {"$t": "timestamp", "v": "2024-01-02T03:04:05"},
                    {"$t": "uuid", "v": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"},
                    {"$t": "array", "v": ["a", "b"]},
                    {"$t": "text", "v": "abc", "truncated": true, "size": 9},
                    8,
                ]],
                "truncated": true,
            })),
            None,
        )
        .unwrap();
    let state = session.snapshot().unwrap();
    let environment = &state["environment"];
    assert_eq!(environment["rows"], 1);
    assert_eq!(environment["truncated"], true);
    assert_eq!(
        environment["columns"],
        "id,total,at,local,uuid,tags,cut,id_8"
    );
    assert_eq!(environment["id"], 7);
    assert_eq!(environment["second"], 8);
    assert_eq!(environment["total"], "19.99");
    assert_eq!(environment["totalKind"], "decimal");
    assert_eq!(environment["totalNumber"], 19.99);
    assert_eq!(environment["at"], "2024-01-02T03:04:05.006Z");
    assert_eq!(environment["local"], "2024-01-02T03:04:05");
    assert_eq!(environment["uuid"], "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11");
    assert_eq!(environment["tags"], "a|b");
    assert_eq!(environment["cut"], true);
    assert!(
        environment["json"]
            .as_str()
            .unwrap()
            .contains("\"total\":\"19.99\"")
    );
    assert_eq!(state["assertions"][0]["passed"], true, "{state}");
}

#[test]
fn transactions_commit_or_roll_back_and_failures_reach_the_script() {
    let session = session();
    session
        .run(
            &[r#"
                const db = nx.sql('Shop');
                db.transaction(async (tx) => {
                    pm.environment.set('nested', typeof tx.transaction);
                    await tx.execute('INSERT INTO t VALUES ($1)', [1]);
                    throw new Error('stop');
                }).catch((error) => pm.environment.set('why', error.message));
                db.queryOne('SELECT 1').catch((error) => pm.environment.set('failed', error.message));
                try { nx.sql(''); } catch (error) { pm.environment.set('empty', error.message); }
                db.query('SELECT 1', 'not an array').catch((error) => pm.environment.set('params', error.message));
                db.transaction('no').catch((error) => pm.environment.set('work', error.message));
            "#
            .into()],
            None,
        )
        .unwrap();
    let calls = session.take_sql().unwrap();
    let methods: Vec<&str> = calls
        .iter()
        .map(|(_, call)| call["method"].as_str().unwrap())
        .collect();
    assert_eq!(methods, ["begin", "query"]);
    session
        .deliver_sql(&calls[1].0, None, Some("no such table"))
        .unwrap();
    session
        .deliver_sql(&calls[0].0, Some(&json!({})), None)
        .unwrap();
    let insert = session.take_sql().unwrap();
    assert_eq!(insert[0].1["method"], "execute");
    session
        .deliver_sql(&insert[0].0, Some(&json!({"affected": 1})), None)
        .unwrap();
    let rollback = session.take_sql().unwrap();
    assert_eq!(rollback[0].1["method"], "rollback");
    session
        .deliver_sql(&rollback[0].0, Some(&json!({})), None)
        .unwrap();
    let state = session.snapshot().unwrap();
    let environment = &state["environment"];
    assert_eq!(environment["why"], "stop");
    assert_eq!(environment["nested"], "undefined");
    assert_eq!(environment["failed"], "no such table");
    assert_eq!(
        environment["empty"],
        "nx.sql needs the name of a saved connection"
    );
    assert_eq!(
        environment["params"],
        "The parameters of a statement are an array"
    );
    assert_eq!(environment["work"], "A transaction runs a function");
    assert!(
        state.get("sql").is_none(),
        "the queue is not part of the state"
    );
}
