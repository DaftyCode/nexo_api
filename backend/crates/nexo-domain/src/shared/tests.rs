use super::*;
use serde_json::json;

fn request(id: &str, url: &str) -> Value {
    json!({"id": id, "name": id, "request": {"method": "GET", "url": url}})
}
fn folder(id: &str, items: Vec<Value>) -> Value {
    json!({"id": id, "name": id, "item": items})
}
fn collection(items: Vec<Value>) -> Value {
    json!({"info": {"name": "Shop"}, "item": items})
}
fn names(value: &Value) -> Vec<String> {
    value["item"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn what_only_one_side_changed_is_taken() {
    let base = collection(vec![request("a", "/a"), request("b", "/b")]);
    let ours = collection(vec![request("a", "/a2"), request("b", "/b")]);
    let theirs = collection(vec![
        request("a", "/a"),
        request("b", "/b2"),
        request("c", "/c"),
    ]);
    let merged = merge(&base, &ours, &theirs);
    assert!(merged.conflicts.is_empty());
    assert_eq!(names(&merged.value), ["a", "b", "c"]);
    assert_eq!(merged.value["item"][0]["request"]["url"], "/a2");
    assert_eq!(merged.value["item"][1]["request"]["url"], "/b2");
    assert_eq!(merged.value["info"]["name"], "Shop");
}

#[test]
fn what_both_changed_differently_keeps_theirs_and_asks() {
    let base = collection(vec![request("a", "/a")]);
    let ours = collection(vec![request("a", "/mine")]);
    let theirs = collection(vec![request("a", "/theirs")]);
    let merged = merge(&base, &ours, &theirs);
    assert_eq!(merged.value["item"][0]["request"]["url"], "/theirs");
    assert_eq!(merged.conflicts.len(), 1);
    assert_eq!(merged.conflicts[0].id, "a");
    assert_eq!(merged.conflicts[0].mine["request"]["url"], "/mine");
    // The same change on both sides is no conflict.
    let same = merge(&base, &ours, &ours);
    assert!(same.conflicts.is_empty());
    // The collection itself, renamed by both.
    let mut renamed = collection(vec![request("a", "/a")]);
    renamed["info"]["name"] = json!("Mine");
    let mut other = renamed.clone();
    other["info"]["name"] = json!("Theirs");
    let root = merge(&base, &renamed, &other);
    assert_eq!(root.conflicts[0].name, "Theirs");
}

#[test]
fn a_deletion_wins_over_nothing_but_not_over_a_change() {
    let base = collection(vec![request("a", "/a"), request("b", "/b")]);
    // They deleted a, which we did not touch; we deleted b, which they changed.
    let ours = collection(vec![request("a", "/a")]);
    let theirs = collection(vec![request("b", "/b2")]);
    let merged = merge(&base, &ours, &theirs);
    assert_eq!(names(&merged.value), ["b"]);
    assert_eq!(merged.value["item"][0]["request"]["url"], "/b2");
}

#[test]
fn folders_keep_where_one_side_moved_them_and_the_order_it_chose() {
    let base = collection(vec![
        request("a", "/a"),
        folder("f", vec![request("b", "/b")]),
        request("c", "/c"),
    ]);
    // We moved c into the folder; they reordered the top and added d after a.
    let ours = collection(vec![
        request("a", "/a"),
        folder("f", vec![request("b", "/b"), request("c", "/c")]),
    ]);
    let theirs = collection(vec![
        folder("f", vec![request("b", "/b")]),
        request("a", "/a"),
        request("d", "/d"),
        request("c", "/c"),
    ]);
    let merged = merge(&base, &ours, &theirs);
    assert!(merged.conflicts.is_empty());
    assert_eq!(names(&merged.value), ["f", "a", "d"]);
    assert_eq!(names(&merged.value["item"][0]), ["b", "c"]);
    // What we added goes after what it followed for us.
    let added = collection(vec![
        request("a", "/a"),
        request("n", "/n"),
        folder("f", vec![request("b", "/b")]),
        request("c", "/c"),
    ]);
    assert_eq!(
        names(&merge(&base, &added, &base).value),
        ["a", "n", "f", "c"]
    );
}

#[test]
fn items_without_ids_and_folders_gone_still_land_somewhere() {
    let base = collection(vec![folder("f", vec![request("b", "/b")])]);
    // They deleted the folder; we added a request in it.
    let ours = collection(vec![folder(
        "f",
        vec![request("b", "/b"), request("n", "/n")],
    )]);
    let theirs = collection(vec![]);
    let merged = merge(&base, &ours, &theirs);
    assert_eq!(names(&merged.value), ["n"]);
    let plain = json!({"info": {"name": "x"}, "item": [{"name": "no id", "request": {}}]});
    assert_eq!(merge(&plain, &plain, &plain).value, plain);
}

#[test]
fn rows_are_joined_by_key_and_theirs_wins_a_tie() {
    let base =
        json!([{"key": "a", "value": "1"}, {"key": "b", "value": "1"}, {"key": "c", "value": "1"}]);
    let ours =
        json!([{"key": "a", "value": "2"}, {"key": "b", "value": "2"}, {"key": "n", "value": "1"}]);
    let theirs =
        json!([{"key": "a", "value": "1"}, {"key": "b", "value": "3"}, {"key": "c", "value": "1"}]);
    assert_eq!(
        merge_rows(&base, &ours, &theirs),
        json!([{"key": "a", "value": "2"}, {"key": "b", "value": "3"}, {"key": "n", "value": "1"}])
    );
}

#[test]
fn the_file_says_what_it_is_and_how_it_is_sealed() {
    let content = json!({"collection": collection(vec![]), "environments": []});
    assert_eq!(
        read(&plain(&content)).unwrap(),
        Envelope::Plain(content.clone())
    );
    assert_eq!(
        read(&sealed("00ff", "abcd")).unwrap(),
        Envelope::Sealed {
            nonce: "00ff".into(),
            data: "abcd".into()
        }
    );
    assert!(
        read(&json!({"info": {}}))
            .unwrap_err()
            .to_string()
            .contains("not a collection")
    );
    let newer = json!({"nexo": FORMAT, "version": 9, "content": content});
    assert!(read(&newer).unwrap_err().to_string().contains("newer Nexo"));
    assert!(read(&json!({"nexo": FORMAT, "version": 1})).is_err());
    assert!(read(&json!({"nexo": FORMAT, "version": 1, "sealed": {"alg": "x"}})).is_err());
    assert_eq!(associated_data(), b"nexo-shared-collection:v1");
    assert!(is_shared_file("D:/Drive/Shop.NEXO-COLLECTION"));
    assert!(!is_shared_file("D:/Drive/notes.txt"));
}

#[test]
fn a_team_key_reads_back_and_every_item_gets_an_id() {
    let key = [7u8; 32];
    let text = key_text(&key);
    assert!(text.starts_with("nexo-team-key-0707"));
    assert_eq!(parse_key(&format!("  {text}\n")).unwrap(), key);
    assert!(parse_key("nexo-team-key-zz").is_err());
    assert!(parse_key(&text.replace("nexo-team-key-", "")).is_err());
    let mut value =
        json!({"item": [{"name": "a"}, {"id": "b", "item": [{"name": "c", "id": ""}]}]});
    let mut next = 0;
    assert!(ensure_ids(&mut value, || {
        next += 1;
        format!("id{next}")
    }));
    assert_eq!(value["item"][0]["id"], "id1");
    assert_eq!(value["item"][1]["item"][0]["id"], "id2");
    assert!(!ensure_ids(&mut value, || unreachable!()));
}
