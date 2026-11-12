use super::*;
use serde_json::json;

#[test]
fn reads_canonical_and_relaxed_extended_json() {
    let filter = document(
        Some(json!({
            "_id": {"$oid": "65a1b2c3d4e5f6a7b8c9d0e1"},
            "at": {"$gte": {"$date": "2024-01-02T03:04:05Z"}},
            "big": {"$numberLong": "9007199254740993"},
            "price": {"$numberDecimal": "1.10"},
            "n": 3,
        })),
        "filter",
    )
    .unwrap()
    .unwrap();
    assert!(matches!(filter.get("_id"), Some(Bson::ObjectId(_))));
    assert!(matches!(
        filter.get_document("at").unwrap().get("$gte"),
        Some(Bson::DateTime(_))
    ));
    assert_eq!(filter.get("big"), Some(&Bson::Int64(9_007_199_254_740_993)));
    assert!(matches!(filter.get("price"), Some(Bson::Decimal128(_))));
    assert_eq!(filter.get("n"), Some(&Bson::Int32(3)));
    // Keys keep their order: it is the order of a sort.
    let sort = document(Some(json!({"b": 1, "a": -1})), "sort")
        .unwrap()
        .unwrap();
    assert_eq!(sort.keys().collect::<Vec<_>>(), ["b", "a"]);
    assert_eq!(
        document(Some(json!([1])), "sort").unwrap_err().to_string(),
        "The sort must be a document"
    );
    assert!(
        document(Some(json!({"a": {"$oid": "nope"}})), "filter")
            .unwrap_err()
            .to_string()
            .starts_with("Invalid Extended JSON in the filter")
    );
}

#[test]
fn writes_documents_in_canonical_extended_json() {
    let raw = RawDocumentBuf::try_from(&doc! {
        "_id": bson::oid::ObjectId::parse_str("65a1b2c3d4e5f6a7b8c9d0e1").unwrap(),
        "n": 1_i32, "big": 2_i64, "x": 1.5,
    })
    .unwrap();
    assert_eq!(
        extended_json(&raw).unwrap(),
        json!({
            "_id": {"$oid": "65a1b2c3d4e5f6a7b8c9d0e1"},
            "n": {"$numberInt": "1"},
            "big": {"$numberLong": "2"},
            "x": {"$numberDouble": "1.5"},
        })
    );
}

#[test]
fn reads_hints_collations_and_page_sizes() {
    assert_eq!(
        hint(Some(json!("at_1"))).unwrap(),
        Some(Hint::Name("at_1".into()))
    );
    assert_eq!(hint(Some(json!(""))).unwrap(), None);
    assert_eq!(
        hint(Some(json!({"at": 1}))).unwrap(),
        Some(Hint::Keys(doc! {"at": 1}))
    );
    assert!(hint(Some(json!(1))).is_err());
    let collation = collation(Some(json!({"locale": "es", "strength": 1})))
        .unwrap()
        .unwrap();
    assert_eq!(collation.locale, "es");
    assert!(
        super::collation(Some(json!({"strength": 1})))
            .unwrap_err()
            .to_string()
            .starts_with("Invalid collation")
    );
    assert!(page_size(0).is_err());
    assert!(page_size(1_001).is_err());
    assert_eq!(page_size(50).unwrap(), 50);
}
