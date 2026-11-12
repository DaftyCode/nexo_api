use super::*;
use serde_json::{Map, json};

/// Twenty documents with known anomalies: `age` has a text value and is missing once,
/// `email` is missing once, `items.[].qty` mixes Int32 and Double, `nickname` is null or
/// text (not an anomaly) in half of them, `address.zip` is in half of the addresses.
fn people() -> Vec<Value> {
    (0..20)
        .map(|n: i64| {
            let mut person = json!({
                "_id": {"$oid": format!("65a1b2c3d4e5f6a7b8c9d0{n:02x}")},
                "name": format!("P{n}"),
                "tags": (0..(n % 3)).map(|t| format!("t{t}")).collect::<Vec<_>>(),
                "address": {"city": if n % 2 == 0 { "Lugo" } else { "Vigo" }},
                "items": [
                    {"sku": "A", "qty": {"$numberInt": "1"}},
                    {"sku": "B", "qty": if n == 3 { json!({"$numberDouble": "1.5"}) } else { json!({"$numberInt": "2"}) }},
                ],
                "at": {"$date": {"$numberLong": (1_700_000_000_000 + n).to_string()}},
            });
            let fields = person.as_object_mut().unwrap();
            match n {
                0 => {}
                1 => {
                    fields.insert("age".into(), json!("old"));
                }
                _ => {
                    fields.insert("age".into(), json!({"$numberInt": (20 + n).to_string()}));
                }
            }
            if n != 5 {
                fields.insert("email".into(), json!(format!("p{n}@example.com")));
            }
            if n < 10 {
                fields.insert("nickname".into(), if n % 2 == 0 { json!(null) } else { json!("nick") });
            }
            if n % 2 == 0 {
                fields["address"]["zip"] = json!("27001");
            }
            person
        })
        .collect()
}

fn field<'a>(report: &'a SchemaReport, path: &str) -> &'a FieldSchema {
    report
        .fields
        .iter()
        .find(|field| field.path == path)
        .unwrap_or_else(|| panic!("no field {path}"))
}

fn types(field: &FieldSchema) -> Vec<(&str, u64)> {
    field
        .types
        .iter()
        .map(|t| (t.name.as_str(), t.count))
        .collect()
}

#[test]
fn finds_the_known_anomalies_and_the_shares_add_up() {
    let report = analyze(&people(), Flavor::Bson);
    assert_eq!(report.sampled, 20);
    assert!(!report.truncated);

    let age = field(&report, "age");
    assert_eq!((age.count, age.parents), (19, 20));
    assert_eq!(types(age), [("Int32", 18), ("String", 1)]);
    assert_eq!(
        age.anomalies,
        [Anomaly::MixedTypes, Anomaly::SometimesMissing]
    );
    let int = &age.types[0];
    assert_eq!(int.min, Some(json!({"$numberInt": "22"})));
    assert_eq!(int.max, Some(json!({"$numberInt": "39"})));

    let email = field(&report, "email");
    assert_eq!((email.count, email.parents), (19, 20));
    assert_eq!(email.anomalies, [Anomaly::SometimesMissing]);

    // Null besides one type is not mixed; present in half is not "almost always".
    let nickname = field(&report, "nickname");
    assert_eq!(types(nickname), [("Null", 5), ("String", 5)]);
    assert!(nickname.anomalies.is_empty());

    for path in [
        "_id",
        "name",
        "tags",
        "address",
        "items",
        "at",
        "address.city",
    ] {
        let found = field(&report, path);
        assert_eq!(found.count, found.parents, "{path}");
        assert!(found.anomalies.is_empty(), "{path}");
    }
    // Fields of embedded documents count over the embedded documents.
    let zip = field(&report, "address.zip");
    assert_eq!((zip.count, zip.parents, zip.depth), (10, 20, 1));
    // Items of arrays, and fields of the documents inside them.
    let items = field(&report, "items.[]");
    assert_eq!((items.count, items.parents), (40, 40));
    assert_eq!(types(items), [("Document", 40)]);
    let qty = field(&report, "items.[].qty");
    assert_eq!((qty.count, qty.parents, qty.depth), (40, 40, 2));
    assert_eq!(types(qty), [("Int32", 39), ("Double", 1)]);
    assert_eq!(qty.anomalies, [Anomaly::MixedTypes]);
}

#[test]
fn counts_values_lengths_and_ranges() {
    let report = analyze(&people(), Flavor::Bson);
    let city = field(&report, "address.city");
    assert_eq!(
        city.values,
        [
            ValueCount {
                value: json!("Lugo"),
                count: 10
            },
            ValueCount {
                value: json!("Vigo"),
                count: 10
            },
        ]
    );
    assert_eq!(city.distinct, 2);
    let name = field(&report, "name");
    assert_eq!(name.values.len(), TOP_VALUES);
    assert_eq!(name.distinct, 20);
    let lengths = name.types[0].lengths.as_ref().unwrap();
    assert_eq!((lengths.min, lengths.max), (2, 3));
    assert_eq!(name.types[0].min, Some(json!("P0")));
    assert_eq!(name.types[0].max, Some(json!("P9")));
    let tags = field(&report, "tags").types[0].lengths.clone().unwrap();
    assert_eq!((tags.min, tags.max), (0, 2));
    let at = &field(&report, "at").types[0];
    assert_eq!(at.name, "Date");
    assert_eq!(
        at.min,
        Some(json!({"$date": {"$numberLong": "1700000000000"}}))
    );
    assert_eq!(
        at.max,
        Some(json!({"$date": {"$numberLong": "1700000000019"}}))
    );
    let id = &field(&report, "_id").types[0];
    assert_eq!(id.name, "ObjectId");
    assert_eq!(id.max, Some(json!({"$oid": "65a1b2c3d4e5f6a7b8c9d013"})));
    // A parent comes before its fields, in the order first seen.
    let order: Vec<&str> = report
        .fields
        .iter()
        .map(|f| f.path.as_str())
        .take(6)
        .collect();
    assert_eq!(
        order,
        ["_id", "name", "tags", "tags.[]", "address", "address.city"]
    );
}

#[test]
fn reads_every_bson_type_and_plain_json() {
    let document = json!({
        "a": {"$numberLong": "5"}, "b": {"$numberDecimal": "1.1"},
        "c": {"$binary": {"base64": "AQ==", "subType": "04"}},
        "d": {"$binary": {"base64": "AQ==", "subType": "00"}},
        "e": {"$regularExpression": {"pattern": "a", "options": ""}},
        "f": {"$timestamp": {"t": 1, "i": 2}}, "g": {"$minKey": 1}, "h": {"$maxKey": 1},
        "i": {"$code": "x", "$scope": {}}, "j": {"$symbol": "s"}, "k": true,
        "l": {"$numberDouble": "NaN"}, "m": {"$other": 1}, "n": 1, "o": 1.5,
    });
    let report = analyze([&document], Flavor::Bson);
    let names: Vec<&str> = report
        .fields
        .iter()
        .map(|f| f.types[0].name.as_str())
        .collect();
    assert_eq!(
        names,
        [
            "Int64",
            "Decimal128",
            "UUID",
            "Binary",
            "RegExp",
            "Timestamp",
            "MinKey",
            "MaxKey",
            "Code",
            "Symbol",
            "Boolean",
            "Double",
            "Document",
            "Int32",
            "Int32",
            "Double",
        ]
    );
    assert_eq!(field(&report, "l").types[0].min, None, "NaN has no order");
    let json = analyze(
        [&json!({"n": 1, "x": 1.5, "o": {"$oid": "1"}})],
        Flavor::Json,
    );
    let names: Vec<&str> = json
        .fields
        .iter()
        .map(|f| f.types[0].name.as_str())
        .collect();
    assert_eq!(names, ["Integer", "Number", "Object", "String"]);
    assert_eq!(json.fields[3].path, "o.$oid");
}

#[test]
fn stops_at_the_limit_of_fields_and_of_values() {
    let wide: Map<String, Value> = (0..MAX_FIELDS + 5)
        .map(|n| (format!("k{n}"), json!(n)))
        .collect();
    let report = analyze([&Value::Object(wide)], Flavor::Json);
    assert!(report.truncated);
    assert_eq!(report.fields.len(), MAX_FIELDS);
    let many: Vec<Value> = (0..TRACKED_VALUES + 3).map(|n| json!({ "n": n })).collect();
    let report = analyze(&many, Flavor::Json);
    assert_eq!(report.fields[0].distinct, TRACKED_VALUES as u64);
    assert!(report.fields[0].distinct_capped);
}

#[test]
fn writes_json_schema_and_a_mongodb_validator() {
    let report = analyze(&people(), Flavor::Bson);
    let validator = json_schema(&report, SchemaDialect::MongoValidator);
    let root = &validator["$jsonSchema"];
    assert_eq!(root["bsonType"], "object");
    assert_eq!(
        root["required"],
        json!(["_id", "name", "tags", "address", "items", "at"])
    );
    assert_eq!(root["properties"]["_id"]["bsonType"], "objectId");
    assert_eq!(
        root["properties"]["age"]["bsonType"],
        json!(["int", "string"])
    );
    assert_eq!(
        root["properties"]["nickname"]["bsonType"],
        json!(["null", "string"])
    );
    assert_eq!(root["properties"]["at"]["bsonType"], "date");
    let address = &root["properties"]["address"];
    assert_eq!(address["required"], json!(["city"]));
    assert_eq!(address["properties"]["zip"]["bsonType"], "string");
    let items = &root["properties"]["items"]["items"];
    assert_eq!(items["bsonType"], "object");
    assert_eq!(
        items["properties"]["qty"]["bsonType"],
        json!(["int", "double"])
    );
    assert_eq!(root["properties"]["tags"]["items"]["bsonType"], "string");

    let schema = json_schema(&report, SchemaDialect::JsonSchema);
    assert_eq!(
        schema["$schema"],
        "https://json-schema.org/draft/2020-12/schema"
    );
    assert_eq!(
        schema["properties"]["age"]["type"],
        json!(["integer", "string"])
    );
    assert_eq!(
        schema["properties"]["items"]["items"]["properties"]["qty"]["type"],
        "number"
    );
    assert_eq!(schema["properties"]["_id"]["type"], "string");

    let odd = analyze(
        [&json!({"t": {"$timestamp": {"t": 1, "i": 1}}})],
        Flavor::Bson,
    );
    let schema = json_schema(&odd, SchemaDialect::JsonSchema);
    assert_eq!(
        schema["properties"]["t"],
        json!({}),
        "a timestamp allows any JSON"
    );
    let empty = json_schema(&analyze([], Flavor::Json), SchemaDialect::JsonSchema);
    assert!(empty.get("properties").is_none());
}
