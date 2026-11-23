//! The tree every driver answers: the databases, and in each one its collections, views,
//! time series collections and GridFS buckets, as the explorer showed them.
use crate::{
    browse,
    error::{Error, Result},
};
use mongodb::Client;
use nexo_driver_sdk::{document::CollectionSummary, protocol::TreeNode};

fn node(kind: &str, name: &str, detail: Option<String>, children: bool) -> TreeNode {
    TreeNode {
        kind: kind.into(),
        name: name.into(),
        label: name.into(),
        detail,
        has_children: children,
        actions: vec!["open".into()],
        system: false,
    }
}

/// The kind of node a collection is: a view, a time series, a file of a GridFS bucket or a
/// collection.
fn collection(summary: &CollectionSummary) -> TreeNode {
    let kind = match (summary.kind.as_str(), &summary.gridfs) {
        (_, Some(_)) => "gridfs",
        ("view", _) => "view",
        ("timeseries", _) => "timeseries",
        _ => "collection",
    };
    let detail = summary
        .view_on
        .as_ref()
        .map(|source| format!("→ {source}"))
        .or_else(|| summary.gridfs.clone());
    let mut node = node(kind, &summary.name, detail, false);
    // Collections of the server itself, as Compass groups them apart.
    node.system = summary.name.starts_with("system.");
    node
}

pub async fn children(
    client: &Client,
    default_database: Option<String>,
    path: &[String],
) -> Result<Vec<TreeNode>> {
    match path {
        [] => Ok(browse::databases(client, default_database)
            .await?
            .into_iter()
            .map(|database| {
                let mut node = node("database", &database.name, None, true);
                node.system = ["admin", "config", "local"].contains(&database.name.as_str());
                node
            })
            .collect()),
        [database] => Ok(browse::collections(client, database)
            .await?
            .iter()
            .map(collection)
            .collect()),
        _ => Err(Error::Validation("A collection has no children".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_collection_is_shown_as_its_kind() {
        let summary = |name: &str, kind: &str| CollectionSummary {
            name: name.into(),
            kind: kind.into(),
            ..CollectionSummary::default()
        };
        assert_eq!(
            collection(&summary("orders", "collection")).kind,
            "collection"
        );
        let view = CollectionSummary {
            view_on: Some("orders".into()),
            ..summary("recent", "view")
        };
        let view = collection(&view);
        assert_eq!(view.kind, "view");
        assert_eq!(view.detail.as_deref(), Some("→ orders"));
        assert_eq!(
            collection(&summary("metrics", "timeseries")).kind,
            "timeseries"
        );
        let files = CollectionSummary {
            gridfs: Some("fs".into()),
            ..summary("fs.files", "collection")
        };
        assert_eq!(collection(&files).kind, "gridfs");
        assert!(collection(&summary("system.views", "collection")).system);
    }
}
