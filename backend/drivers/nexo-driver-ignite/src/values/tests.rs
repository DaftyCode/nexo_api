use super::*;
use crate::tuple::Builder;

fn field(type_id: i64, scale: i64) -> Field {
    Field {
        name: "c".into(),
        type_id,
        scale,
        ..Field::default()
    }
}
fn read(type_id: i64, scale: i64, bytes: &[u8]) -> Value {
    cell(Some(bytes), &field(type_id, scale)).unwrap()
}
fn typed(kind: ValueKind, text: &str) -> Value {
    Value::typed(kind, text)
}

#[test]
fn every_type_has_its_sql_name_and_kind() {
    assert_eq!(type_name(DECIMAL, 10, 2), "DECIMAL(10, 2)");
    assert_eq!(type_name(STRING, 64, 0), "VARCHAR(64)");
    assert_eq!(type_name(STRING, -1, 0), "VARCHAR");
    assert_eq!(
        type_name(TIMESTAMP, 6, 0),
        "TIMESTAMP(6) WITH LOCAL TIME ZONE"
    );
    assert_eq!(type_name(99, 0, 0), "TYPE 99");
    let kinds: Vec<_> = (0..=18).map(kind).collect();
    assert_eq!(kinds[INT16 as usize], ValueKind::Integer);
    assert_eq!(kinds[DATETIME as usize], ValueKind::Timestamp);
    assert_eq!(kinds[DURATION as usize], ValueKind::Interval);
    assert_eq!(kinds[14], ValueKind::Other);
    let column = Field {
        name: "PRICE".into(),
        nullable: true,
        type_id: DECIMAL,
        scale: 2,
        precision: 10,
        origin: Some(("PUBLIC".into(), "ITEMS".into(), "PRICE".into())),
    }
    .column();
    assert_eq!(column.nullable, Some(true));
    assert_eq!(column.origin.unwrap().table, "ITEMS");
}

#[test]
fn numbers_keep_their_type() {
    assert_eq!(read(BOOLEAN, 0, &[1]), Value::Bool(true));
    assert_eq!(read(INT8, 0, &[0xff]), Value::Integer(-1));
    assert_eq!(
        read(INT32, 0, &(-300i16).to_le_bytes()),
        Value::Integer(-300)
    );
    assert_eq!(
        read(INT64, 0, &(1i64 << 40).to_le_bytes()),
        Value::Integer(1 << 40)
    );
    assert_eq!(read(FLOAT, 0, &0.1f32.to_le_bytes()), Value::Float(0.1));
    assert_eq!(read(DOUBLE, 0, &2.5f64.to_le_bytes()), Value::Float(2.5));
    assert_eq!(read(DOUBLE, 0, &2.5f32.to_le_bytes()), Value::Float(2.5));
    // 1.5 with scale 1 in a column of scale 2.
    assert_eq!(
        read(DECIMAL, 2, &[1, 0, 15]),
        typed(ValueKind::Decimal, "1.50")
    );
    assert_eq!(cell(Some(&[1, 2, 3]), &field(INT32, 0)), None);
    assert_eq!(cell(None, &field(INT32, 0)), Some(Value::Null));
}

#[test]
fn decimals_of_any_size_go_both_ways() {
    for (written, column_scale, shown) in [
        ("-12.50", 2, "-12.50"),
        ("0.05", 2, "0.05"),
        ("-0.05", -1, "-0.05"),
        ("1e3", 0, "1000"),
        ("-128", 0, "-128"),
        (
            "123456789012345678901234567890.123",
            3,
            "123456789012345678901234567890.123",
        ),
        ("-98765432109876543210", 0, "-98765432109876543210"),
        ("0", 0, "0"),
    ] {
        let (_, element) = decimal::element(written).unwrap();
        assert_eq!(
            decimal::text(&element, column_scale).unwrap(),
            shown,
            "{written}"
        );
    }
    let (scale, unscaled) = decimal::bytes("-1.5").unwrap();
    assert_eq!(
        (scale, unscaled),
        (1, vec![0xf1]),
        "as BigInteger writes -15"
    );
    assert_eq!(decimal::bytes("12x"), None);
    assert_eq!(decimal::bytes(""), None);
    assert_eq!(decimal::text(&[1], 0), None);
}

/// How a date or a time is written, and read back.
type Write = fn(&str) -> Option<Vec<u8>>;
type Read = fn(&[u8]) -> Option<String>;

#[test]
fn dates_and_times_go_both_ways() {
    let cases: [(Write, Read, &str); 9] = [
        (time::date_bytes, time::date, "2024-02-29"),
        (time::date_bytes, time::date, "-0044-03-15"),
        (time::time_bytes, time::time, "23:59:58"),
        (time::time_bytes, time::time, "10:20:30.125"),
        (time::time_bytes, time::time, "10:20:30.000125"),
        (time::time_bytes, time::time, "10:20:30.000000125"),
        (
            time::datetime_bytes,
            time::datetime,
            "2024-01-02 03:04:05.500",
        ),
        (time::instant_bytes, time::instant, "1969-12-31T23:59:59Z"),
        (
            time::instant_bytes,
            time::instant,
            "2024-01-02T03:04:05.000001Z",
        ),
    ];
    for (write, read, text) in cases {
        let bytes = write(text).unwrap();
        assert_eq!(read(&bytes).unwrap(), text);
    }
    assert_eq!(time::time_bytes("10:20:30.5").unwrap().len(), 4);
    assert_eq!(time::time_bytes("10:20:30.000125").unwrap().len(), 5);
    let offset = time::instant_bytes("2024-01-02 05:04:05+02:00").unwrap();
    assert_eq!(time::instant(&offset).unwrap(), "2024-01-02T03:04:05Z");
    let west = time::instant_bytes("2024-01-01T22:00-05:00").unwrap();
    assert_eq!(time::instant(&west).unwrap(), "2024-01-02T03:00:00Z");
    for wrong in ["2024-13-01", "x", "2024-01-01"] {
        assert_eq!(time::datetime_bytes(wrong), None, "{wrong}");
    }
    assert_eq!(time::time_bytes("25:00"), None);
    assert_eq!(time::time_bytes("10:00:00.1234567891"), None);
    assert_eq!(time::time(&[1, 2, 3]), None);
    assert_eq!(time::instant(&[1, 2, 3]), None);
}

#[test]
fn intervals_read_as_java_writes_them() {
    assert_eq!(time::period(&[1, 2, 0]).unwrap(), "P1Y2M");
    assert_eq!(time::period(&[0, 0, 0]).unwrap(), "P0D");
    let mut wide = 300i16.to_le_bytes().to_vec();
    wide.extend([0, 0, 5, 0]);
    assert_eq!(time::period(&wide).unwrap(), "P300Y5D");
    let mut widest = 70_000i32.to_le_bytes().to_vec();
    widest.extend([0; 8]);
    assert_eq!(time::period(&widest).unwrap(), "P70000Y");
    assert_eq!(time::period(&[1]), None);
    assert_eq!(time::duration(&5400i64.to_le_bytes()).unwrap(), "PT1H30M");
    assert_eq!(time::duration(&0i64.to_le_bytes()).unwrap(), "PT0S");
    let mut half = 1i64.to_le_bytes().to_vec();
    half.extend(500_000_000u32.to_le_bytes());
    assert_eq!(time::duration(&half).unwrap(), "PT1.5S");
    assert_eq!(time::duration(&(-90i64).to_le_bytes()).unwrap(), "-PT1M30S");
    assert_eq!(
        read(PERIOD, 0, &[0, 3, 0]),
        typed(ValueKind::Interval, "P3M")
    );
}

#[test]
fn texts_binaries_and_uuids_are_read() {
    assert_eq!(read(STRING, 0, b"hola"), Value::Text("hola".into()));
    assert_eq!(read(STRING, 0, &[0x80]), Value::Text(String::new()));
    assert_eq!(
        read(BYTE_ARRAY, 0, &[0x80, 0x80, 1]),
        Value::bytes(&[0x80, 1])
    );
    let uuid = crate::msgpack::uuid_bytes("00112233-4455-6677-8899-aabbccddeeff").unwrap();
    assert_eq!(
        read(UUID, 0, &uuid),
        typed(ValueKind::Uuid, "00112233-4455-6677-8899-aabbccddeeff")
    );
    let huge = vec![7u8; limits::VALUE_BYTES + 1];
    match read(BYTE_ARRAY, 0, &huge) {
        Value::Typed { full_size, .. } => assert_eq!(full_size, Some(huge.len() as u64)),
        other => panic!("{other:?}"),
    }
    assert_eq!(read(0, 0, &[1]), Value::Null);
}

#[test]
fn a_row_is_read_by_its_columns() {
    let mut builder = Builder::default();
    builder.int(7).null().varlen(b"x");
    let fields = [field(INT32, 0), field(STRING, 0), field(STRING, 0)];
    let row = row(&builder.build(), &fields).unwrap();
    assert_eq!(
        row,
        [Value::Integer(7), Value::Null, Value::Text("x".into())]
    );
    let mut broken = Builder::default();
    broken.raw(&[1, 2, 3]);
    assert!(super::row(&broken.build(), &[field(INT64, 0)]).is_err());
}

#[test]
fn arguments_go_as_type_scale_and_value() {
    let values = [
        Value::Null,
        Value::Bool(true),
        Value::Integer(300),
        Value::Float(1.5),
        Value::Text("O'Brien".into()),
        typed(ValueKind::Decimal, "1.25"),
        typed(ValueKind::Integer, "99999999999999999999"),
        typed(ValueKind::Date, "2024-01-02"),
        typed(ValueKind::Time, "03:04:05"),
        typed(ValueKind::Timestamp, "2024-01-02 03:04:05"),
        typed(ValueKind::Timestamptz, "2024-01-02T03:04:05Z"),
        typed(ValueKind::Uuid, "00112233-4455-6677-8899-aabbccddeeff"),
        Value::bytes(&[1, 2]),
        typed(ValueKind::Boolean, "false"),
        typed(ValueKind::Float, "2.5"),
        typed(ValueKind::Json, "{}"),
        typed(ValueKind::Integer, "12"),
    ];
    let bytes = args::tuple(&values).unwrap().unwrap();
    let tuple = Tuple::parse(&bytes, values.len() * 3).unwrap();
    let id = |at: usize| tuple.get(at * 3).and_then(integer);
    let expected = [
        None,
        Some(BOOLEAN),
        Some(INT64),
        Some(DOUBLE),
        Some(STRING),
        Some(DECIMAL),
        Some(DECIMAL),
        Some(DATE),
        Some(TIME),
        Some(DATETIME),
        Some(TIMESTAMP),
        Some(UUID),
        Some(BYTE_ARRAY),
        Some(BOOLEAN),
        Some(DOUBLE),
        Some(STRING),
        Some(INT64),
    ];
    for (at, expected) in expected.iter().enumerate() {
        assert_eq!(id(at), *expected, "argument {at}");
    }
    assert_eq!(tuple.get(5 * 3 + 1).and_then(integer), Some(2), "the scale");
    assert_eq!(tuple.get(2 * 3 + 2).and_then(integer), Some(300));
    assert_eq!(args::tuple(&[]).unwrap(), None);
    for refused in [
        typed(ValueKind::Interval, "P1D"),
        typed(ValueKind::Date, "never"),
        typed(ValueKind::Boolean, "maybe"),
        typed(ValueKind::Float, "x"),
        typed(ValueKind::Decimal, "x"),
        typed(ValueKind::Integer, "x"),
        typed(ValueKind::Time, "x"),
        typed(ValueKind::Timestamp, "x"),
        typed(ValueKind::Timestamptz, "x"),
        typed(ValueKind::Uuid, "x"),
        typed(ValueKind::Binary, "%%"),
        Value::Array(vec![]),
    ] {
        assert!(
            args::tuple(std::slice::from_ref(&refused)).is_err(),
            "{refused:?}"
        );
    }
}
