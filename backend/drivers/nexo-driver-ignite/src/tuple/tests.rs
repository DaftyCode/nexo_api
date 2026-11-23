use super::*;

#[test]
fn a_tuple_is_read_as_ignite_builds_it() {
    // An integer, a null, "ab" and an empty text, with one-byte offsets.
    let bytes = [0x00, 1, 1, 3, 4, 0x07, b'a', b'b', 0x80];
    let tuple = Tuple::parse(&bytes, 4).unwrap();
    assert_eq!(tuple.get(0), Some(&[7][..]));
    assert_eq!(tuple.get(1), None, "an empty element is null");
    assert_eq!(tuple.get(2).map(varlen), Some(&b"ab"[..]));
    assert_eq!(tuple.get(3).map(varlen), Some(&[][..]));
    assert_eq!(tuple.get(4), None);
}

#[test]
fn the_builder_writes_what_the_parser_reads() {
    let mut builder = Builder::default();
    builder
        .int(5)
        .int(-300)
        .int(70_000)
        .int(1 << 40)
        .null()
        .varlen(b"")
        .varlen(&[0x80, 1])
        .raw(&[9, 9]);
    let bytes = builder.build();
    assert_eq!(bytes[0], 0, "offsets of one byte for few values");
    let tuple = Tuple::parse(&bytes, 8).unwrap();
    assert_eq!(tuple.get(0), Some(&[5][..]));
    assert_eq!(tuple.get(1), Some(&(-300i16).to_le_bytes()[..]));
    assert_eq!(tuple.get(2), Some(&70_000i32.to_le_bytes()[..]));
    assert_eq!(tuple.get(3), Some(&(1i64 << 40).to_le_bytes()[..]));
    assert_eq!(tuple.get(4), None);
    assert_eq!(tuple.get(5), Some(&[0x80][..]));
    assert_eq!(tuple.get(6).map(varlen), Some(&[0x80, 1][..]));
    assert_eq!(tuple.get(7), Some(&[9, 9][..]));
}

#[test]
fn large_values_take_wider_offsets() {
    let mut builder = Builder::default();
    builder.raw(&[1; 300]).raw(&[2; 70_000]);
    let bytes = builder.build();
    assert_eq!(bytes[0], 2, "four-byte offsets past 64 KiB");
    let tuple = Tuple::parse(&bytes, 2).unwrap();
    assert_eq!(tuple.get(1).map(<[u8]>::len), Some(70_000));
    let mut builder = Builder::default();
    builder.raw(&[1; 300]);
    assert_eq!(builder.build()[0], 1);
}

#[test]
fn a_broken_tuple_is_refused() {
    assert!(Tuple::parse(&[], 1).is_err());
    assert!(Tuple::parse(&[0x03, 0], 1).is_err(), "no 8-byte offsets");
    assert!(Tuple::parse(&[0x00, 1], 2).is_err(), "the table is cut");
    assert!(
        Tuple::parse(&[0x00, 5, 1], 1).is_err(),
        "an end past the values"
    );
    assert!(
        Tuple::parse(&[0x00, 2, 1, 7, 7], 2).is_err(),
        "ends go back"
    );
}
