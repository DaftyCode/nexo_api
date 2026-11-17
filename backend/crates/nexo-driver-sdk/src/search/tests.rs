use super::*;
use crate::{
    Column, Driver, HostLink, ValueKind,
    protocol::{
        Capabilities, ConnectParams, Dialect, DriverInfo, Hello, ObjectParams, ParameterStyle,
        ServerInfo, TreeNode,
    },
    statements::{CursorParams, ExecuteParams, ExecuteResult, FetchParams, Page},
};
use async_trait::async_trait;
use std::sync::Mutex;

#[test]
fn patterns_take_wildcards_literally_or_as_typed() {
    assert_eq!(like_pattern("50%_off!", false), "%50!%!_off!!%");
    assert_eq!(like_pattern("a[b]", true), "%a![b]%");
    assert_eq!(like_pattern("a[b]", false), "%a[b]%");
    assert_eq!(name_pattern("Order"), "%order%");
    assert_eq!(name_pattern("ord*s?"), "ord%s_");
    assert_eq!(name_pattern("%order%"), "%order%");
}

#[test]
fn rows_are_checked_for_case_and_whole_words() {
    assert!(matches("The Lamp", "lamp", false, false));
    assert!(!matches("The Lamp", "lamp", true, false));
    assert!(matches("a lamp, b", "lamp", false, true));
    assert!(!matches("lamps", "lamp", false, true));
    assert!(!matches("my_lamp", "lamp", false, true));
    assert!(!matches("anything", "", false, false));
}

/// Answers the probe of a table with its columns and every other query with three rows.
struct Fake {
    asked: Mutex<Vec<(String, Vec<Value>)>>,
}
#[async_trait]
impl Driver for Fake {
    fn hello(&self) -> Hello {
        Hello {
            protocol: 1,
            driver: DriverInfo {
                id: "fake".into(),
                name: "Fake".into(),
                version: "1".into(),
            },
            capabilities: Capabilities::default(),
            dialect: Dialect {
                name: "postgresql".into(),
                quote_open: "\"".into(),
                quote_close: "\"".into(),
                parameters: ParameterStyle::Numbered,
                ..Dialect::default()
            },
        }
    }
    async fn connect(&self, _: &HostLink, _: ConnectParams) -> Result<ServerInfo> {
        Ok(ServerInfo::default())
    }
    async fn disconnect(&self, _: &str) -> Result<()> {
        Ok(())
    }
    async fn tree(&self, _: ObjectParams) -> Result<Vec<TreeNode>> {
        Ok(Vec::new())
    }
    async fn execute(&self, params: ExecuteParams) -> Result<ExecuteResult> {
        self.asked
            .lock()
            .unwrap()
            .push((params.sql.clone(), params.params.clone()));
        let columns = vec![
            Column::new("id", "int4", ValueKind::Integer),
            Column::new("label", "text", ValueKind::Text),
            Column::new("photo", "bytea", ValueKind::Binary),
        ];
        if params.sql.ends_with("WHERE 1 = 0") {
            return Ok(ExecuteResult {
                columns,
                ..ExecuteResult::default()
            });
        }
        if params.sql.starts_with("SELECT n.nspname") {
            return Ok(ExecuteResult {
                rows: vec![vec![
                    Value::Text("shop".into()),
                    Value::Null,
                    Value::Text("orders".into()),
                    Value::Null,
                    Value::Bool(false),
                ]],
                ..ExecuteResult::default()
            });
        }
        let row =
            |id, label: &str| vec![Value::Integer(id), Value::Text(label.into()), Value::Null];
        Ok(ExecuteResult {
            columns,
            rows: vec![row(7, "Lamp"), row(8, "lampshade"), row(9, "desk 7")],
            ..ExecuteResult::default()
        })
    }
    async fn fetch(&self, _: FetchParams) -> Result<Page> {
        Ok(Page::default())
    }
    async fn close(&self, _: CursorParams) -> Result<()> {
        Ok(())
    }
}

struct Catalog;
impl SearchCatalog for Catalog {
    fn queries(&self, pattern: &str, _: &SearchParams) -> Vec<CatalogQuery> {
        vec![CatalogQuery {
            kind: "table",
            sql: "SELECT n.nspname, NULL, c.relname, NULL, false FROM pg_class c WHERE c.relname LIKE $1".into(),
            params: vec![Value::Text(pattern.into())],
        }]
    }
    fn path(
        &self,
        kind: &str,
        schema: Option<&str>,
        _: Option<&str>,
        name: &str,
        _: Option<&str>,
    ) -> Vec<String> {
        vec![
            "db".into(),
            "schemas".into(),
            schema.unwrap_or_default().into(),
            format!("{kind}s"),
            name.into(),
        ]
    }
    fn text_of(&self, column: &str, kind: &str) -> Option<String> {
        (kind != "binary").then(|| format!("{column}::text"))
    }
}

fn params(mode: SearchMode, text: &str) -> SearchParams {
    SearchParams {
        connection: "c".into(),
        statement: "search-1".into(),
        mode,
        text: text.into(),
        kinds: Vec::new(),
        code: false,
        schemas: Vec::new(),
        max: None,
        tables: vec![SearchTable {
            schema: Some("shop".into()),
            name: "items".into(),
            path: vec!["db".into(), "items".into()],
        }],
        case_sensitive: false,
        whole_word: false,
        columns: Vec::new(),
        max_rows: Some(10),
    }
}

#[tokio::test]
async fn data_is_searched_with_bound_values_and_checked_again() {
    let fake = Fake {
        asked: Mutex::default(),
    };
    let mut asked = params(SearchMode::Data, "lamp");
    asked.whole_word = true;
    let found = run(&fake, asked, &Catalog).await.unwrap();
    let (sql, values) = fake.asked.lock().unwrap()[1].clone();
    assert_eq!(
        sql,
        "SELECT * FROM \"shop\".\"items\" WHERE LOWER(\"label\"::text) LIKE $1 ESCAPE '!'"
    );
    assert_eq!(values, [Value::Text("%lamp%".into())]);
    // `lampshade` is not the whole word.
    let hit = &found.data[0];
    assert_eq!(hit.rows.len(), 1);
    assert_eq!(hit.matched, ["label"]);
    assert_eq!(hit.path, ["db", "items"]);

    // A whole number looks in the numbers too.
    let fake = Fake {
        asked: Mutex::default(),
    };
    let found = run(&fake, params(SearchMode::Data, "7"), &Catalog)
        .await
        .unwrap();
    let (sql, values) = fake.asked.lock().unwrap()[1].clone();
    assert!(sql.contains("\"id\" = $1 OR LOWER(\"label\"::text) LIKE $2"));
    assert_eq!(values[0], Value::Integer(7));
    assert_eq!(found.data[0].matched, ["id", "label"]);
}

#[tokio::test]
async fn objects_are_found_with_their_place_in_the_tree() {
    let fake = Fake {
        asked: Mutex::default(),
    };
    let found = run(&fake, params(SearchMode::Metadata, "Order"), &Catalog)
        .await
        .unwrap();
    assert_eq!(
        fake.asked.lock().unwrap()[0].1,
        [Value::Text("%order%".into())]
    );
    assert_eq!(found.objects[0].name, "orders");
    assert_eq!(
        found.objects[0].path,
        ["db", "schemas", "shop", "tables", "orders"]
    );
    let empty = run(&fake, params(SearchMode::Metadata, "  "), &Catalog).await;
    assert!(empty.is_err());
}
