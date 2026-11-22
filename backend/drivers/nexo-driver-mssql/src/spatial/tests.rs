use super::ewkb_hex;

fn hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).unwrap())
        .collect()
}

#[test]
fn a_geography_point_becomes_ewkb_longitude_first() {
    // geography::Point(47.651, -122.349, 4326), as SQL Server serializes it.
    let point = hex("E6100000010C17D9CEF753D34740D34D6210585FA5C0");
    let ewkb = ewkb_hex(&point).unwrap();
    assert_eq!(&ewkb[..18], "0101000020E6100000");
    // Longitude, then latitude.
    assert_eq!(&ewkb[18..34], "D34D6210585FA5C0");
    assert_eq!(&ewkb[34..], "17D9CEF753D34740");
}

/// A value of the general layout: points, figures and shapes.
fn general(
    srid: i32,
    points: &[(f64, f64)],
    figures: &[i32],
    shapes: &[(i32, i32, u8)],
) -> Vec<u8> {
    let mut bytes = srid.to_le_bytes().to_vec();
    bytes.extend([1, 0x04]);
    bytes.extend((points.len() as i32).to_le_bytes());
    for (x, y) in points {
        bytes.extend(x.to_le_bytes());
        bytes.extend(y.to_le_bytes());
    }
    bytes.extend((figures.len() as i32).to_le_bytes());
    for figure in figures {
        bytes.push(1);
        bytes.extend(figure.to_le_bytes());
    }
    bytes.extend((shapes.len() as i32).to_le_bytes());
    for (parent, figure, kind) in shapes {
        bytes.extend(parent.to_le_bytes());
        bytes.extend(figure.to_le_bytes());
        bytes.push(*kind);
    }
    bytes
}

#[test]
fn lines_polygons_and_collections_keep_their_figures() {
    let square = [(0.0, 0.0), (4.0, 0.0), (4.0, 4.0), (0.0, 0.0)];
    let polygon = general(0, &square, &[0], &[(-1, 0, 3)]);
    let ewkb = ewkb_hex(&polygon).unwrap();
    // Polygon with an SRID of 0, one ring of four points.
    assert!(
        ewkb.starts_with("010300002000000000010000000400000000"),
        "{ewkb}"
    );
    let multi = general(
        0,
        &[(1.0, 1.0), (2.0, 2.0), (3.0, 3.0)],
        &[0, 1],
        &[(-1, 0, 5), (0, 0, 2), (0, 1, 2)],
    );
    let ewkb = ewkb_hex(&multi).unwrap();
    // MultiLineString of two lines, each a plain WKB without SRID.
    assert!(
        ewkb.starts_with("0105000020000000000200000001020000000100000000"),
        "{ewkb}"
    );
    let empty = general(0, &[], &[], &[(-1, -1, 1)]);
    assert!(
        ewkb_hex(&empty)
            .unwrap()
            .ends_with("000000000000F87F000000000000F87F")
    );
}

#[test]
fn what_is_not_a_spatial_value_stays_its_bytes() {
    for bytes in [vec![], vec![1, 2, 3], hex("5AC0"), hex("E61000000300")] {
        assert!(ewkb_hex(&bytes).is_none(), "{bytes:?}");
    }
    let mut point = hex("E6100000010C17D9CEF753D34740D34D6210585FA5C0");
    point.push(0);
    assert!(ewkb_hex(&point).is_none());
    let curve = general(0, &[(0.0, 0.0)], &[0], &[(-1, 0, 8)]);
    assert!(ewkb_hex(&curve).is_none());
}
