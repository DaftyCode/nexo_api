use super::*;

#[test]
fn writes_moments_and_clocks_as_iso_8601() {
    assert_eq!(
        moment(ValueKind::Timestamp, (2026, 11, 16, 9, 5, 7, 120_000), 2),
        Value::typed(ValueKind::Timestamp, "2026-11-16T09:05:07.12")
    );
    assert_eq!(
        moment(ValueKind::Date, (0, 0, 0, 0, 0, 0, 0), 0),
        Value::typed(ValueKind::Date, "0000-00-00")
    );
    assert_eq!(clock(false, (33, 8, 0, 0, 0), 0), "800:00:00");
    assert_eq!(clock(true, (0, 1, 2, 3, 500_000), 6), "-01:02:03.500000");
    // A computed value has no fixed digits: written without trailing zeros.
    assert_eq!(clock(false, (0, 1, 2, 3, 500_000), 31), "01:02:03.5");
    assert_eq!(fraction(0, 31), "");
}

#[test]
fn reads_text_by_the_class_of_its_column() {
    assert_eq!(
        from_bytes(b"18446744073709551615".to_vec(), ValueKind::Integer, false),
        Value::typed(ValueKind::Decimal, "18446744073709551615")
    );
    assert_eq!(
        from_bytes(b"-5".to_vec(), ValueKind::Integer, false),
        Value::Integer(-5)
    );
    assert_eq!(
        from_bytes(vec![1, 0], ValueKind::Integer, true),
        Value::Integer(256)
    );
    assert_eq!(
        from_bytes(vec![1], ValueKind::Boolean, true),
        Value::Bool(true)
    );
    assert_eq!(
        from_bytes(b"2026-11-16 10:00:00".to_vec(), ValueKind::Timestamp, false),
        Value::typed(ValueKind::Timestamp, "2026-11-16T10:00:00")
    );
    assert_eq!(
        from_bytes(b"12.50".to_vec(), ValueKind::Decimal, false),
        Value::typed(ValueKind::Decimal, "12.50")
    );
    assert_eq!(
        from_bytes(b"1.5".to_vec(), ValueKind::Float, false),
        Value::Float(1.5)
    );
    assert_eq!(
        from_bytes(vec![0, 255], ValueKind::Binary, false),
        Value::bytes(&[0, 255])
    );
    assert_eq!(
        from_bytes(vec![0, 255], ValueKind::Spatial, false),
        Value::typed(ValueKind::Spatial, "00FF")
    );
    // POINT(1 2) with SRID 4326 as MySQL keeps it, and as EWKB.
    let mut point = vec![0xE6, 0x10, 0, 0, 1, 1, 0, 0, 0];
    point.extend(1.0_f64.to_le_bytes());
    point.extend(2.0_f64.to_le_bytes());
    assert_eq!(
        from_bytes(point, ValueKind::Spatial, false),
        Value::typed(
            ValueKind::Spatial,
            "0101000020E6100000000000000000F03F0000000000000040"
        )
    );
    let mut big = vec![0xE6, 0x10, 0, 0, 0, 0, 0, 0, 1];
    big.extend(1.0_f64.to_be_bytes());
    big.extend(2.0_f64.to_be_bytes());
    assert_eq!(
        from_bytes(big, ValueKind::Spatial, false),
        Value::typed(
            ValueKind::Spatial,
            "0020000001000010E63FF00000000000004000000000000000"
        )
    );
}
