use super::*;
use crate::documents::answers;
use serde_json::json;

#[test]
fn requests_keep_every_field_on_the_wire() {
    let request = app::FindRequest {
        id: "q".into(),
        database: "shop".into(),
        collection: "orders".into(),
        filter: Some(json!({"a": 1})),
        projection: Some(json!({"a": 1})),
        sort: Some(json!({"a": -1})),
        collation: Some(json!({"locale": "es"})),
        hint: Some(json!("a_1")),
        skip: Some(2),
        limit: Some(5),
        page_size: 10,
    };
    let sent = find(request.clone());
    assert_eq!(sent.filter, request.filter);
    assert_eq!((sent.skip, sent.limit, sent.page_size), (Some(2), Some(5), 10));
    let explained = explain(app::ExplainRequest {
        id: "e".into(),
        database: "shop".into(),
        collection: "orders".into(),
        explained: app::Explained::Find(Box::new(request)),
        execution_stats: true,
    });
    assert!(matches!(explained.explained, wire::Explained::Find(ref f) if f.page_size == 10));
    let options = app::AggregateOptions {
        allow_disk_use: true,
        max_time_ms: Some(10),
        ..app::AggregateOptions::default()
    };
    let sent = aggregate(app::AggregateRequest {
        pipeline: vec![json!({"$match": {}})],
        options: options.clone(),
        page_size: 3,
        ..app::AggregateRequest::default()
    });
    assert!(sent.options.allow_disk_use);
    assert_eq!(sent.options.max_time_ms, Some(10));
    let written = aggregate_write(app::AggregateWrite {
        options,
        ..app::AggregateWrite::default()
    });
    assert!(written.options.allow_disk_use);
    let counted = count(app::CountRequest {
        skip: Some(1),
        ..app::CountRequest::default()
    });
    assert_eq!(counted.skip, Some(1));
}

#[test]
fn writes_and_their_changes_go_and_come_back_whole() {
    let change = app::DocumentChange {
        before: Some(json!({"a": 0})),
        after: Some(json!({"a": 1})),
    };
    let restore = write(app::DocumentWrite::Restore {
        changes: vec![change.clone()],
    });
    assert!(matches!(restore, wire::DocumentWrite::Restore { ref changes } if changes.len() == 1));
    for kind in [
        app::DocumentWrite::Insert { documents: vec![] },
        app::DocumentWrite::Update {
            filter: json!({}),
            update: json!({}),
            many: true,
            expected: Some(1),
        },
        app::DocumentWrite::Replace {
            filter: json!({}),
            replacement: json!({}),
        },
        app::DocumentWrite::Delete {
            filter: json!({}),
            many: false,
            expected: None,
        },
    ] {
        let _ = write(kind);
    }
    let back = written(wire::WriteResult {
        matched: 1,
        changes: vec![wire::DocumentChange {
            before: change.before.clone(),
            after: change.after.clone(),
        }],
        ..wire::WriteResult::default()
    });
    assert_eq!(back.changes, vec![change]);
    let validator = collection_change(app::CollectionChange::Validator {
        database: "d".into(),
        collection: "c".into(),
        validator: json!({}),
        level: "strict",
        action: "warn",
    });
    assert!(matches!(validator, wire::CollectionChange::Validator { ref level, .. } if level == "strict"));
    for change in [
        app::CollectionChange::Create {
            database: "d".into(),
            collection: "c".into(),
            options: None,
        },
        app::CollectionChange::Rename {
            database: "d".into(),
            collection: "c".into(),
            to: "e".into(),
        },
        app::CollectionChange::Drop {
            database: "d".into(),
            collection: "c".into(),
        },
        app::CollectionChange::DropDatabase {
            database: "d".into(),
        },
    ] {
        let _ = collection_change(change);
    }
    for change in [
        app::IndexChange::Create {
            database: "d".into(),
            collection: "c".into(),
            keys: json!({"a": 1}),
            options: None,
        },
        app::IndexChange::Hide {
            database: "d".into(),
            collection: "c".into(),
            name: "a_1".into(),
            hidden: true,
        },
        app::IndexChange::Drop {
            database: "d".into(),
            collection: "c".into(),
            name: "a_1".into(),
        },
    ] {
        let _ = index_change(change);
    }
    let sent = batch(app::ImportBatch {
        documents: vec![json!({})],
        upsert_key: Some(vec!["_id".into()]),
        clear: true,
        ordered: false,
    });
    assert_eq!(sent.upsert_key, Some(vec!["_id".into()]));
    let watched = watch(app::WatchRequest {
        full_document: Some("updateLookup".into()),
        ..app::WatchRequest::default()
    });
    assert_eq!(watched.full_document.as_deref(), Some("updateLookup"));
    assert_eq!(
        target(app::WriteTarget {
            write_concern: Some(json!({"w": 1})),
            ..app::WriteTarget::default()
        })
        .write_concern,
        Some(json!({"w": 1}))
    );
}

#[test]
fn answers_become_the_application_types() {
    let report = answers::report(wire::ConnectionReport {
        topology: "replicaSet".into(),
        hosts: vec![wire::DatabaseHost {
            address: "a:1".into(),
            role: "primary".into(),
            allowed: false,
            reason: Some("no".into()),
        }],
        ..wire::ConnectionReport::default()
    });
    assert_eq!(report.hosts[0].reason.as_deref(), Some("no"));
    assert!(answers::database(wire::DatabaseSummary::default()).name.is_empty());
    let collection = answers::collection(wire::CollectionSummary {
        gridfs: Some("fs".into()),
        ..wire::CollectionSummary::default()
    });
    assert_eq!(collection.gridfs.as_deref(), Some("fs"));
    let stats = answers::stats(wire::CollectionStats {
        indexes: vec![wire::IndexSummary::default()],
        ..wire::CollectionStats::default()
    });
    assert_eq!(stats.indexes.len(), 1);
    let page = answers::page(wire::DocumentPage {
        cursor: Some("c".into()),
        ..wire::DocumentPage::default()
    });
    assert_eq!(page.cursor.as_deref(), Some("c"));
    assert_eq!(answers::index(wire::IndexDetail::default()).size, None);
    assert_eq!(answers::profile(wire::ProfileStatus::default()).level, 0);
    assert_eq!(answers::profiled(wire::ProfileEntry::default()).millis, 0);
    let imported = answers::imported(wire::ImportResult {
        failed: vec![wire::ImportFailure {
            index: 2,
            message: "dup".into(),
        }],
        ..wire::ImportResult::default()
    });
    assert_eq!(imported.failed[0].index, 2);
    assert!(answers::events(wire::WatchEvents::default()).events.is_empty());
    assert!(answers::watching(wire::WatchSummary::default()).id.is_empty());
}
