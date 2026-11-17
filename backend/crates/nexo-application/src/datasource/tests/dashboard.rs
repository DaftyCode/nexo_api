//! The dashboard of a server: its panels from the driver, and readings that only read.
use super::*;

#[tokio::test]
async fn the_panels_come_from_the_driver_of_the_session() {
    let (application, _, sources) = with_sources(json!({}));
    connect(&application, "dashboard:c1").await.unwrap();
    let panels = application
        .execute(Operation::DbDashboards, json!({"session": "dashboard:c1"}))
        .await
        .unwrap();
    assert_eq!(panels["dashboards"][0]["id"], "sessions");
    let (session, request) = sources.administered.lock().unwrap()[0].clone();
    assert_eq!(
        (session.as_str(), request),
        ("dashboard:c1", json!({"connection": "dashboard:c1"}))
    );
}

#[tokio::test]
async fn a_reading_runs_one_read_and_is_not_kept_in_the_history() {
    let (application, fake, sources) = with_sources(json!({"readOnly": true}));
    connect(&application, "dashboard:c1").await.unwrap();
    let read = |sql: &str| {
        application.execute(
            Operation::DbDashboardRead,
            json!({"session": "dashboard:c1", "statement": "panel-1", "sql": sql}),
        )
    };
    let answer = read("SELECT count(*) AS active FROM pg_stat_activity")
        .await
        .unwrap();
    assert_eq!(answer["rows"], json!([[1], [2]]));
    let (_, request) = sources.executed.lock().unwrap()[0].clone();
    assert_eq!(
        (request.page_rows, request.max_rows),
        (Some(100), Some(100))
    );
    for (sql, says) in [
        ("DELETE FROM t", "only reads"),
        ("CREATE TABLE t (id int)", "only reads"),
        ("SET search_path TO x", "only reads"),
        ("SELECT 1; SELECT 2", "one query"),
        ("", "one query"),
    ] {
        assert!(message(read(sql).await).contains(says), "{sql}");
    }
    assert_eq!(sources.executed.lock().unwrap().len(), 1);
    let history = fake.documents.lock().unwrap();
    assert!(
        !history
            .iter()
            .any(|document| document.kind == DocumentKind::SqlHistory)
    );
}
