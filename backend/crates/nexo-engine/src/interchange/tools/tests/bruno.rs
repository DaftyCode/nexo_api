//! Bruno collection folders and JSON exports.
use super::super::super::import;
use super::*;
use serde_json::{Value, json};

/// The files of the Bruno collection of `fixtures/bruno`, as the interface sends them: with
/// the name of the folder chosen in front.
pub(super) fn bruno_files() -> Vec<Value> {
    [
        ("bruno.json", include_str!("../fixtures/bruno/bruno.json")),
        (
            "collection.bru",
            include_str!("../fixtures/bruno/collection.bru"),
        ),
        (
            "environments/Local.bru",
            include_str!("../fixtures/bruno/environments/Local.bru"),
        ),
        (
            "users/folder.bru",
            include_str!("../fixtures/bruno/users/folder.bru"),
        ),
        (
            "users/Get user.bru",
            include_str!("../fixtures/bruno/users/Get user.bru"),
        ),
        (
            "users/Create user.bru",
            include_str!("../fixtures/bruno/users/Create user.bru"),
        ),
        (
            "users/Upload photo.bru",
            include_str!("../fixtures/bruno/users/Upload photo.bru"),
        ),
        ("Sign in.bru", include_str!("../fixtures/bruno/Sign in.bru")),
        ("Pets.bru", include_str!("../fixtures/bruno/Pets.bru")),
        (
            "keys/signing.key",
            include_str!("../fixtures/bruno/keys/signing.key"),
        ),
        ("node_modules/x/bad.bru", "get {\n  url: http://never\n}\n"),
    ]
    .into_iter()
    .map(|(path, content)| json!({"path": format!("pet-store/{path}"), "content": content}))
    .collect()
}

#[test]
fn bruno_folders_read_every_block_of_their_files() {
    let result = import(&json!({"content": "", "files": bruno_files()})).unwrap();
    let collection = &result["value"];
    assert_eq!(collection["info"]["name"], "Pet Store");
    assert_eq!(
        collection["info"]["description"],
        "The pet store, as Bruno keeps it."
    );
    assert_eq!(collection["auth"]["type"], "bearer");
    assert_eq!(row(&collection["variable"], "apiVersion"), "v1");
    let names: Vec<&str> = collection["item"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        ["People", "Sign in", "Pets"],
        "in the order of their seq"
    );
    let people = at(collection, &["People"]);
    assert!(people.get("auth").is_none());
    assert_eq!(row(&people["variable"], "limit"), "20");
    let people_items: Vec<&str> = people["item"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["name"].as_str().unwrap())
        .collect();
    assert_eq!(people_items, ["Create user", "Get user", "Upload photo"]);
    let get = at(collection, &["People", "Get user"]);
    let request = &get["request"];
    assert_eq!(request["url"]["raw"], "{{baseUrl}}/users/:id?fields=name");
    assert_eq!(
        request["url"]["variable"],
        json!([{"key": "id", "value": "7"}])
    );
    assert_eq!(
        get["nexoDisabledQuery"],
        json!([{"key": "sort by", "value": "name"}])
    );
    let headers: Vec<(&str, bool)> = request["header"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| (h["key"].as_str().unwrap(), h["disabled"] == true))
        .collect();
    assert_eq!(
        headers,
        [
            ("X-Client", false),
            ("X-Debug", true),
            ("X-Area", false),
            ("Accept", false),
            ("X-Quoted", false)
        ]
    );
    assert_eq!(request["description"], "Reads a user.");
    assert_eq!(
        script(get, "prerequest"),
        "pm.variables.set(\"userId\", \"7\");"
    );
    assert!(
        script(get, "test").contains(
            "// test(\"is the user\", function () {
//   expect("
        ),
        "the tests block, commented"
    );
    let create = &at(collection, &["People", "Create user"])["request"];
    assert_eq!(row(&create["auth"]["basic"], "password"), "{{password}}");
    assert_eq!(
        create["body"]["raw"],
        "{\n  \"name\": \"Rex\",\n  \"tags\": [\"dog\"]\n}"
    );
    let upload = &at(collection, &["People", "Upload photo"])["request"];
    assert_eq!(upload["auth"]["type"], "noauth");
    let parts = &upload["body"]["formdata"];
    assert_eq!(
        parts[1],
        json!({"key": "photo", "type": "file", "src": "rex.png", "disabled": false, "contentType": "image/png"})
    );
    assert_eq!(parts[2]["src"], json!(["a.png", "b.png"]));
    let sign_in = &at(collection, &["Sign in"])["request"];
    assert_eq!(sign_in["body"]["urlencoded"][1]["disabled"], true);
    let oauth1 = &sign_in["auth"]["oauth1"];
    assert_eq!(
        row(oauth1, "privateKey"),
        "test-only-signing-key\n",
        "the key file, as text"
    );
    assert_eq!(row(oauth1, "privateKeyType"), "text");
    assert_eq!(row(oauth1, "addParamsToHeader"), true);
    let pets = &at(collection, &["Pets"])["request"];
    assert_eq!(
        pets["body"]["graphql"]["query"],
        "query Pets($first: Int) {\n  pets(first: $first) { id name }\n}"
    );
    let oauth2 = &pets["auth"]["oauth2"];
    assert_eq!(row(oauth2, "grant_type"), "client_credentials");
    assert_eq!(row(oauth2, "autoFetchToken"), true);
    assert_eq!(row(oauth2, "tokenRequestParams")[0]["key"], "audience");
    let local = &result["more"][0]["value"];
    assert_eq!(local["name"], "Local");
    assert_eq!(
        row(&local["values"], "certificate"),
        "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----"
    );
    assert_eq!(local["values"][1]["enabled"], false);
    assert_eq!(local["values"][3]["type"], "secret");
    for (code, item) in [
        ("script", "Pet Store"),
        ("script", "Create user"),
        ("vars", "Get user"),
        ("tests", "Get user"),
        ("file", "Upload photo"),
        ("secret", "Local: token"),
    ] {
        assert!(
            noted(&result, code, item),
            "{code} {item}: {:?}",
            codes(&result)
        );
    }
    assert_eq!(result["report"]["requests"], 5, "node_modules is left out");
}

#[test]
fn bruno_folders_need_their_bruno_json() {
    let files = json!([{"path": "a/x.bru", "content": "get {\n  url: http://a.test\n}\n"}]);
    let error = import(&json!({"content": "", "files": files})).unwrap_err();
    assert!(error.to_string().contains("bruno.json"));
}

#[test]
fn bruno_json_exports_import_like_their_folders() {
    let result = imported(include_str!("../fixtures/bruno-export.json"));
    let collection = &result["value"];
    assert_eq!(collection["auth"]["type"], "bearer");
    let get = &at(collection, &["People", "Get user"])["request"];
    assert_eq!(get["url"]["raw"], "{{baseUrl}}/users/:id?fields=name");
    assert_eq!(get["header"][0]["key"], "X-Client");
    let create = at(collection, &["People", "Create user"]);
    assert_eq!(
        row(&create["request"]["auth"]["awsv4"], "secretKey"),
        "{{awsSecret}}"
    );
    assert_eq!(
        script(create, "prerequest"),
        "pm.variables.set(\"kind\", \"dog\");"
    );
    assert!(noted(&result, "unsupported", "Stream pets"));
    assert!(noted(&result, "secret", "Local: token"));
    assert!(noted(&result, "tests", "Get user"));
}
