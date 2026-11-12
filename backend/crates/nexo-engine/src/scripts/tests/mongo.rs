//! `nx.mongo` in the sandbox: calls queued with Extended JSON arguments, results turned into
//! BSON values, and nothing of the connection but its name.
use super::*;

#[test]
fn calls_are_queued_with_their_bson_types_and_results_come_back_as_values() {
    let session = session();
    session
        .run(
            &[r#"
                pm.test('stored', async () => {
                    const orders = nx.mongo('Local').db('shop').collection('orders');
                    const order = await orders.findOne({
                        _id: ObjectId('65A1B2C3D4E5F6A7B8C9D0E1'),
                        at: ISODate('2024-01-02T03:04:05.006Z'),
                        big: NumberLong('9007199254740993'),
                        price: NumberDecimal('19.99'),
                        n: 7,
                        ratio: 1.5,
                        name: /^ab/i,
                        missing: undefined,
                    });
                    pm.environment.set('id', order._id.toHexString());
                    pm.environment.set('idIsObjectId', order._id instanceof ObjectId);
                    pm.environment.set('year', order.at.getUTCFullYear());
                    pm.environment.set('n', order.n);
                    pm.environment.set('big', String(order.big));
                    pm.environment.set('price', order.price.toString());
                    pm.environment.set('same', order._id.equals('65a1b2c3d4e5f6a7b8c9d0e1'));
                    pm.expect(order.tags).to.eql(['a']);
                });
                nx.mongo('Local').db('shop').collection('orders').find({ n: 1 }).sort({ at: -1 }).limit(5).toArray();
            "#
            .into()],
            None,
        )
        .unwrap();
    let calls = session.take_mongo().unwrap();
    assert_eq!(calls.len(), 2);
    let (id, call) = &calls[0];
    assert_eq!(call["connection"], "Local");
    assert_eq!(
        (call["database"].as_str(), call["collection"].as_str()),
        (Some("shop"), Some("orders"))
    );
    assert_eq!(call["method"], "findOne");
    assert_eq!(
        call["arguments"][0],
        json!({
            "_id": {"$oid": "65a1b2c3d4e5f6a7b8c9d0e1"},
            "at": {"$date": {"$numberLong": "1704164645006"}},
            "big": {"$numberLong": "9007199254740993"},
            "price": {"$numberDecimal": "19.99"},
            "n": 7,
            "ratio": 1.5,
            "name": {"$regularExpression": {"pattern": "^ab", "options": "i"}},
        })
    );
    assert_eq!(calls[1].1["method"], "find");
    assert_eq!(
        calls[1].1["arguments"][1],
        json!({"sort": {"at": -1}, "limit": 5})
    );

    session
        .deliver_mongo(
            id,
            Some(&json!({
                "_id": {"$oid": "65a1b2c3d4e5f6a7b8c9d0e1"},
                "at": {"$date": {"$numberLong": "1704164645006"}},
                "n": {"$numberInt": "7"},
                "big": {"$numberLong": "9007199254740993"},
                "price": {"$numberDecimal": "19.99"},
                "tags": ["a"],
            })),
            None,
        )
        .unwrap();
    let state = session.snapshot().unwrap();
    let environment = &state["environment"];
    assert_eq!(environment["id"], "65a1b2c3d4e5f6a7b8c9d0e1");
    assert_eq!(environment["idIsObjectId"], true);
    assert_eq!(environment["year"], 2024);
    assert_eq!(environment["n"], 7);
    assert_eq!(environment["big"], "9007199254740993");
    assert_eq!(environment["price"], "19.99");
    assert_eq!(environment["same"], true);
    assert_eq!(state["assertions"][0]["passed"], true);
    assert!(
        state.get("mongo").is_none(),
        "the queue is not part of the state"
    );
}

#[test]
fn a_failed_call_rejects_and_the_test_says_why() {
    let session = session();
    session
        .run(
            &["pm.test('write', async () => { await nx.mongo('Production').db('shop').collection('orders').insertOne({ a: 1 }); });".into()],
            None,
        )
        .unwrap();
    let calls = session.take_mongo().unwrap();
    session
        .deliver_mongo(
            &calls[0].0,
            None,
            Some("The connection Production is read-only: Nexo refuses its writes"),
        )
        .unwrap();
    let state = session.snapshot().unwrap();
    assert_eq!(state["assertions"][0]["passed"], false);
    assert_eq!(
        state["assertions"][0]["error"],
        "The connection Production is read-only: Nexo refuses its writes"
    );
}

#[test]
fn bson_values_are_checked_as_the_shell_checks_them() {
    let session = session();
    for (source, message) in [
        (
            "ObjectId('xyz')",
            "An ObjectId is 24 hexadecimal characters",
        ),
        ("NumberLong('1.5')", "A NumberLong is a whole number"),
        ("NumberInt(2 ** 40)", "A NumberInt fits in 32 bits"),
        ("ISODate('yesterday')", "Invalid date: yesterday"),
        ("UUID('zz')", "A UUID is 32 hexadecimal digits"),
        (
            "nx.mongo('')",
            "nx.mongo needs the name of a saved connection",
        ),
    ] {
        let error = session.run(&[source.into()], None).unwrap_err().to_string();
        assert!(error.contains(message), "{source}: {error}");
    }
    session
        .run(
            &[r#"
                const id = ObjectId();
                pm.environment.set('generated', /^[0-9a-f]{24}$/.test(id.toHexString()));
                pm.environment.set('recent', Date.now() - id.getTimestamp().getTime() < 60000);
                pm.environment.set('uuid', JSON.stringify(UUID('3b241101-e2bb-4255-8caf-4136c566a962')));
            "#
            .into()],
            None,
        )
        .unwrap();
    let environment = &session.snapshot().unwrap()["environment"];
    assert_eq!(environment["generated"], true);
    assert_eq!(environment["recent"], true);
    assert_eq!(
        environment["uuid"],
        r#"{"$binary":{"base64":"OyQRAeK7QlWMr0E2xWapYg==","subType":"04"}}"#
    );
}
