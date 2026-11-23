use super::*;

fn written(write: impl FnOnce(&mut Writer)) -> Vec<u8> {
    let mut writer = Writer::default();
    write(&mut writer);
    writer.into_bytes()
}

#[test]
fn integers_go_in_their_smallest_form_as_the_java_client_writes_them() {
    let cases: [(i64, &[u8]); 12] = [
        (0, &[0x00]),
        (127, &[0x7f]),
        (-1, &[0xff]),
        (-32, &[0xe0]),
        (128, &[0xcc, 0x80]),
        (-33, &[0xd0, 0xdf]),
        (300, &[0xcd, 0x01, 0x2c]),
        (-200, &[0xd1, 0xff, 0x38]),
        (70_000, &[0xce, 0x00, 0x01, 0x11, 0x70]),
        (-70_000, &[0xd2, 0xff, 0xfe, 0xee, 0x90]),
        (1 << 40, &[0xcf, 0, 0, 1, 0, 0, 0, 0, 0]),
        (-(1 << 40), &[0xd3, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0]),
    ];
    for (value, bytes) in cases {
        let found = written(|writer| {
            writer.int(value);
        });
        assert_eq!(found, bytes, "{value}");
        assert_eq!(Reader::new(&found).int().unwrap(), value);
    }
}

#[test]
fn texts_binaries_and_flags_are_read_back() {
    let long = "x".repeat(300);
    let bytes = written(|writer| {
        writer
            .nil()
            .bool(true)
            .bool(false)
            .str("Ignite")
            .str(&long)
            .str("")
            .bin(&[1, 2, 3]);
    });
    let mut reader = Reader::new(&bytes);
    assert!(reader.nil().unwrap());
    assert!(!reader.nil().unwrap());
    assert!(reader.bool().unwrap());
    assert!(!reader.bool().unwrap());
    assert_eq!(reader.opt_str().unwrap().as_deref(), Some("Ignite"));
    assert_eq!(reader.str().unwrap(), long);
    assert_eq!(reader.str().unwrap(), "");
    assert_eq!(reader.bin().unwrap(), [1, 2, 3]);
    assert!(reader.nil().is_err(), "the message has ended");
}

#[test]
fn a_uuid_keeps_the_order_ignite_writes_its_halves_in() {
    let text = "00112233-4455-6677-8899-aabbccddeeff";
    let bytes = uuid_bytes(text).unwrap();
    assert_eq!(bytes[0], 0x77, "the first half is little-endian");
    assert_eq!(bytes[8], 0xff, "and so is the second");
    assert_eq!(uuid_text(&bytes), text);
    let mut message = vec![0xd8, 3];
    message.extend(bytes);
    assert_eq!(Reader::new(&message).uuid().unwrap(), bytes);
    assert!(Reader::new(&[0xd8, 4]).uuid().is_err());
    assert_eq!(uuid_bytes("not a uuid"), None);
}

#[test]
fn any_value_can_be_skipped_and_a_broken_one_is_refused() {
    // A map of a text to an array of a float, an extension and a nested map.
    let message = [
        0x81, 0xa1, b'k', 0x93, 0xcb, 0, 0, 0, 0, 0, 0, 0, 0, 0xd4, 1, 2, 0x81, 0x01, 0xc0, 0x2a,
    ];
    let mut reader = Reader::new(&message);
    reader.skip().unwrap();
    assert_eq!(reader.int().unwrap(), 42);
    for broken in [&[0xc1][..], &[0xa3, b'a'], &[0xcd, 0x01], &[0xc4, 0x05, 1]] {
        assert!(Reader::new(broken).skip().is_err(), "{broken:?}");
    }
    let deep = vec![0x91; 100];
    assert!(Reader::new(&deep).skip().is_err(), "nested too deep");
    let huge = [0xcf, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
    assert!(Reader::new(&huge).int().is_err());
    assert!(Reader::new(&[0xa1, 0xff]).str().is_err(), "not UTF-8");
    assert!(Reader::new(&[0x01]).bool().is_err());
    assert!(Reader::new(&[0x01]).bin().is_err());
    assert!(Reader::new(&[0xc3]).int().is_err());
}
