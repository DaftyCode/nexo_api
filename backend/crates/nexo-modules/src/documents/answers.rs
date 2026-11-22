//! The driver's answers as the application's types, field by field.
use nexo_application::ports as app;
use nexo_driver_sdk::document as wire;

pub(super) fn report(r: wire::ConnectionReport) -> app::ConnectionReport {
    app::ConnectionReport {
        server_version: r.server_version,
        topology: r.topology,
        replica_set: r.replica_set,
        flavor: r.flavor,
        hosts: r
            .hosts
            .into_iter()
            .map(|host| app::DatabaseHost {
                address: host.address,
                role: host.role,
                allowed: host.allowed,
                reason: host.reason,
            })
            .collect(),
        ping_ms: r.ping_ms,
        direct: r.direct,
        tls: r.tls,
        auth_mechanism: r.auth_mechanism,
    }
}

pub(super) fn database(d: wire::DatabaseSummary) -> app::DatabaseSummary {
    app::DatabaseSummary {
        name: d.name,
        size_on_disk: d.size_on_disk,
        empty: d.empty,
    }
}

pub(super) fn collection(c: wire::CollectionSummary) -> app::CollectionSummary {
    app::CollectionSummary {
        name: c.name,
        kind: c.kind,
        gridfs: c.gridfs,
        view_on: c.view_on,
        capped: c.capped,
    }
}

pub(super) fn stats(s: wire::CollectionStats) -> app::CollectionStats {
    app::CollectionStats {
        count: s.count,
        size: s.size,
        storage_size: s.storage_size,
        average_document_size: s.average_document_size,
        total_index_size: s.total_index_size,
        indexes: s
            .indexes
            .into_iter()
            .map(|index| app::IndexSummary {
                name: index.name,
                keys: index.keys,
                unique: index.unique,
            })
            .collect(),
        capped: s.capped,
    }
}

pub(super) fn page(p: wire::DocumentPage) -> app::DocumentPage {
    app::DocumentPage {
        documents: p.documents,
        cursor: p.cursor,
        truncated: p.truncated,
        elapsed_ms: p.elapsed_ms,
    }
}

pub(super) fn index(i: wire::IndexDetail) -> app::IndexDetail {
    app::IndexDetail {
        name: i.name,
        spec: i.spec,
        size: i.size,
        accesses: i.accesses,
        since: i.since,
    }
}

pub(super) fn profile(p: wire::ProfileStatus) -> app::ProfileStatus {
    app::ProfileStatus {
        level: p.level,
        slowms: p.slowms,
        sample_rate: p.sample_rate,
    }
}

pub(super) fn profiled(e: wire::ProfileEntry) -> app::ProfileEntry {
    app::ProfileEntry {
        op: e.op,
        ns: e.ns,
        millis: e.millis,
        ts: e.ts,
        plan_summary: e.plan_summary,
        docs_examined: e.docs_examined,
        keys_examined: e.keys_examined,
        returned: e.returned,
        command: e.command,
    }
}

pub(super) fn imported(r: wire::ImportResult) -> app::ImportResult {
    app::ImportResult {
        inserted: r.inserted,
        upserted: r.upserted,
        replaced: r.replaced,
        cleared: r.cleared,
        failed: r
            .failed
            .into_iter()
            .map(|failure| app::ImportFailure {
                index: failure.index,
                message: failure.message,
            })
            .collect(),
    }
}

pub(super) fn events(e: wire::WatchEvents) -> app::WatchEvents {
    app::WatchEvents {
        id: e.id,
        state: e.state,
        events: e.events,
    }
}

pub(super) fn watching(w: wire::WatchSummary) -> app::WatchSummary {
    app::WatchSummary {
        id: w.id,
        protocol: w.protocol,
        url: w.url,
        state: w.state,
    }
}
