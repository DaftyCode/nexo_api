//! Kinds of documents stored in a workspace.
use super::*;

/// Kinds of documents stored in a workspace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DocumentKind {
    Collection,
    Environment,
    Globals,
    History,
    Run,
    Mock,
    Dataset,
    Api,
    Monitor,
    Comment,
    Settings,
    /// A database connection (MongoDB): its URI without the password, which stays in the
    /// vault.
    Connection,
    /// A saved database query (MongoDB `find`), with its connection, database and collection.
    Query,
    /// A database query that was run: only the query, never its results.
    #[serde(rename = "query-history")]
    QueryHistory,
    /// A write on a database, with the documents before and after it to undo it.
    #[serde(rename = "database-change")]
    DatabaseChange,
    /// A saved import or export of a database (MongoDB): where it reads, where it writes,
    /// the format and the mapping of fields, run again by hand.
    #[serde(rename = "mongo-transfer")]
    Transfer,
}
impl DocumentKind {
    pub const ALL: [DocumentKind; 16] = [
        Self::Collection,
        Self::Environment,
        Self::Globals,
        Self::History,
        Self::Run,
        Self::Mock,
        Self::Dataset,
        Self::Api,
        Self::Monitor,
        Self::Comment,
        Self::Settings,
        Self::Connection,
        Self::Query,
        Self::QueryHistory,
        Self::DatabaseChange,
        Self::Transfer,
    ];
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Collection => "collection",
            Self::Environment => "environment",
            Self::Globals => "globals",
            Self::History => "history",
            Self::Run => "run",
            Self::Mock => "mock",
            Self::Dataset => "dataset",
            Self::Api => "api",
            Self::Monitor => "monitor",
            Self::Comment => "comment",
            Self::Settings => "settings",
            Self::Connection => "connection",
            Self::Query => "query",
            Self::QueryHistory => "query-history",
            Self::DatabaseChange => "database-change",
            Self::Transfer => "mongo-transfer",
        }
    }
    pub fn parse(value: &str) -> Result<Self> {
        Self::ALL
            .into_iter()
            .find(|kind| kind.as_str() == value)
            .ok_or_else(|| Error::Validation("Unknown resource kind".into()))
    }
    /// History entries (of requests and of queries) and run reports never change after they
    /// are written.
    pub fn keeps_revisions(self) -> bool {
        !matches!(
            self,
            Self::History | Self::Run | Self::QueryHistory | Self::DatabaseChange
        )
    }
    /// Request history and run reports grow with use, so a workspace lists them without
    /// their values; a query of the history and a database change (whose documents are kept
    /// only while they are small) are listed whole.
    pub fn listed_whole(self) -> bool {
        !matches!(self, Self::History | Self::Run)
    }
}
