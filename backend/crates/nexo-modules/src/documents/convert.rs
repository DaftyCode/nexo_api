//! The application's requests as the `document` extension carries them, and its answers back
//! as the application's types. Field by field, so a field added on one side and not on the
//! other fails to compile here.
use nexo_application::ports as app;
use nexo_driver_sdk::document as wire;

pub(super) fn find(r: app::FindRequest) -> wire::FindRequest {
    wire::FindRequest {
        id: r.id,
        database: r.database,
        collection: r.collection,
        filter: r.filter,
        projection: r.projection,
        sort: r.sort,
        collation: r.collation,
        hint: r.hint,
        skip: r.skip,
        limit: r.limit,
        page_size: r.page_size,
    }
}

fn options(o: app::AggregateOptions) -> wire::AggregateOptions {
    wire::AggregateOptions {
        collation: o.collation,
        hint: o.hint,
        allow_disk_use: o.allow_disk_use,
        max_time_ms: o.max_time_ms,
    }
}

pub(super) fn aggregate(r: app::AggregateRequest) -> wire::AggregateRequest {
    wire::AggregateRequest {
        id: r.id,
        database: r.database,
        collection: r.collection,
        pipeline: r.pipeline,
        options: options(r.options),
        page_size: r.page_size,
    }
}

pub(super) fn aggregate_write(r: app::AggregateWrite) -> wire::AggregateWrite {
    wire::AggregateWrite {
        id: r.id,
        database: r.database,
        collection: r.collection,
        pipeline: r.pipeline,
        options: options(r.options),
    }
}

pub(super) fn count(r: app::CountRequest) -> wire::CountRequest {
    wire::CountRequest {
        id: r.id,
        database: r.database,
        collection: r.collection,
        filter: r.filter,
        collation: r.collation,
        hint: r.hint,
        skip: r.skip,
        limit: r.limit,
    }
}

pub(super) fn explain(r: app::ExplainRequest) -> wire::ExplainRequest {
    wire::ExplainRequest {
        id: r.id,
        database: r.database,
        collection: r.collection,
        explained: match r.explained {
            app::Explained::Find(find_request) => {
                wire::Explained::Find(Box::new(find(*find_request)))
            }
            app::Explained::Aggregate {
                pipeline,
                collation,
                hint,
            } => wire::Explained::Aggregate {
                pipeline,
                collation,
                hint,
            },
        },
        execution_stats: r.execution_stats,
    }
}

pub(super) fn target(t: app::WriteTarget) -> wire::WriteTarget {
    wire::WriteTarget {
        database: t.database,
        collection: t.collection,
        write_concern: t.write_concern,
    }
}

fn change_out(c: app::DocumentChange) -> wire::DocumentChange {
    wire::DocumentChange {
        before: c.before,
        after: c.after,
    }
}
fn change_in(c: wire::DocumentChange) -> app::DocumentChange {
    app::DocumentChange {
        before: c.before,
        after: c.after,
    }
}

pub(super) fn write(w: app::DocumentWrite) -> wire::DocumentWrite {
    match w {
        app::DocumentWrite::Insert { documents } => wire::DocumentWrite::Insert { documents },
        app::DocumentWrite::Update {
            filter,
            update,
            many,
            expected,
        } => wire::DocumentWrite::Update {
            filter,
            update,
            many,
            expected,
        },
        app::DocumentWrite::Replace {
            filter,
            replacement,
        } => wire::DocumentWrite::Replace {
            filter,
            replacement,
        },
        app::DocumentWrite::Delete {
            filter,
            many,
            expected,
        } => wire::DocumentWrite::Delete {
            filter,
            many,
            expected,
        },
        app::DocumentWrite::Restore { changes } => wire::DocumentWrite::Restore {
            changes: changes.into_iter().map(change_out).collect(),
        },
    }
}

pub(super) fn written(r: wire::WriteResult) -> app::WriteResult {
    app::WriteResult {
        matched: r.matched,
        modified: r.modified,
        deleted: r.deleted,
        inserted: r.inserted,
        changes: r.changes.into_iter().map(change_in).collect(),
    }
}

pub(super) fn collection_change(c: app::CollectionChange) -> wire::CollectionChange {
    match c {
        app::CollectionChange::Create {
            database,
            collection,
            options,
        } => wire::CollectionChange::Create {
            database,
            collection,
            options,
        },
        app::CollectionChange::Rename {
            database,
            collection,
            to,
        } => wire::CollectionChange::Rename {
            database,
            collection,
            to,
        },
        app::CollectionChange::Drop {
            database,
            collection,
        } => wire::CollectionChange::Drop {
            database,
            collection,
        },
        app::CollectionChange::DropDatabase { database } => {
            wire::CollectionChange::DropDatabase { database }
        }
        app::CollectionChange::Validator {
            database,
            collection,
            validator,
            level,
            action,
        } => wire::CollectionChange::Validator {
            database,
            collection,
            validator,
            level: level.into(),
            action: action.into(),
        },
    }
}

pub(super) fn index_change(c: app::IndexChange) -> wire::IndexChange {
    match c {
        app::IndexChange::Create {
            database,
            collection,
            keys,
            options,
        } => wire::IndexChange::Create {
            database,
            collection,
            keys,
            options,
        },
        app::IndexChange::Hide {
            database,
            collection,
            name,
            hidden,
        } => wire::IndexChange::Hide {
            database,
            collection,
            name,
            hidden,
        },
        app::IndexChange::Drop {
            database,
            collection,
            name,
        } => wire::IndexChange::Drop {
            database,
            collection,
            name,
        },
    }
}

pub(super) fn batch(b: app::ImportBatch) -> wire::ImportBatch {
    wire::ImportBatch {
        documents: b.documents,
        upsert_key: b.upsert_key,
        clear: b.clear,
        ordered: b.ordered,
    }
}

pub(super) fn watch(r: app::WatchRequest) -> wire::WatchRequest {
    wire::WatchRequest {
        database: r.database,
        collection: r.collection,
        pipeline: r.pipeline,
        full_document: r.full_document,
        full_document_before_change: r.full_document_before_change,
        resume_after: r.resume_after,
    }
}

#[cfg(test)]
#[path = "convert_tests.rs"]
mod tests;
