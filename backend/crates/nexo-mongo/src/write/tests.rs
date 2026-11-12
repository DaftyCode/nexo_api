use super::*;
use serde_json::json;

#[test]
fn reads_write_concerns_and_refuses_unacknowledged_ones() {
    assert_eq!(write_concern(None).unwrap(), None);
    let concern = write_concern(Some(json!({"w": "majority", "j": true, "wtimeout": 500})))
        .unwrap()
        .unwrap();
    assert_eq!(concern.w, Some(Acknowledgment::Majority));
    assert_eq!(concern.journal, Some(true));
    assert_eq!(concern.w_timeout, Some(Duration::from_millis(500)));
    assert_eq!(
        write_concern(Some(json!({"w": 2}))).unwrap().unwrap().w,
        Some(Acknowledgment::Nodes(2))
    );
    assert!(
        write_concern(Some(json!({"w": 0})))
            .unwrap_err()
            .to_string()
            .contains("Unacknowledged")
    );
    assert!(write_concern(Some(json!({"j": "yes"}))).is_err());
}

#[test]
fn a_restored_document_must_be_unchanged() {
    let document = doc! {"_id": 1, "at": bson::DateTime::from_millis(5), "n": {"a": [1]}};
    assert_eq!(
        unchanged(&document).unwrap(),
        doc! {
            "_id": 1,
            "$expr": {"$eq": ["$$ROOT", {"$literal": document.clone()}]},
        }
    );
    assert_eq!(by_id(&document).unwrap(), doc! {"_id": 1});
    assert!(by_id(&doc! {"a": 1}).is_err());
}
