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
    /// A saved aggregation pipeline (MongoDB): its connection, database, collection, stages
    /// as typed (also those turned off) and options.
    #[serde(rename = "mongo-aggregation")]
    Aggregation,
    /// A saved comparison of two collections (MongoDB): both sides, the filter, the key and
    /// the fields left out, run again by hand.
    #[serde(rename = "mongo-compare")]
    Comparison,
    /// A saved SQL script: its connection, the database and schema it runs in, and its text.
    #[serde(rename = "sql-script")]
    SqlScript,
    /// A statement that was run on a SQL connection: its text, time, rows and error, never
    /// its results.
    #[serde(rename = "sql-history")]
    SqlHistory,
    /// What a workspace shows when it opens again: its open tabs with their unsaved changes
    /// (the files chosen for them by name only), the active tab, the section shown and the
    /// order of its collections. Never responses.
    Session,
}
impl DocumentKind {
    pub const ALL: [DocumentKind; 21] = [
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
        Self::Aggregation,
        Self::Comparison,
        Self::SqlScript,
        Self::SqlHistory,
        Self::Session,
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
            Self::Aggregation => "mongo-aggregation",
            Self::Comparison => "mongo-compare",
            Self::SqlScript => "sql-script",
            Self::SqlHistory => "sql-history",
            Self::Session => "session",
        }
    }
    pub fn parse(value: &str) -> Result<Self> {
        Self::ALL
            .into_iter()
            .find(|kind| kind.as_str() == value)
            .ok_or_else(|| Error::Validation("Unknown resource kind".into()))
    }
    /// History entries (of requests and of queries) and run reports never change after they
    /// are written. A session changes with every tab moved or edited: only its last state
    /// matters.
    pub fn keeps_revisions(self) -> bool {
        !matches!(
            self,
            Self::History
                | Self::Run
                | Self::QueryHistory
                | Self::DatabaseChange
                | Self::SqlHistory
                | Self::Session
        )
    }
    /// Request history and run reports grow with use, so a workspace lists them without
    /// their values; a query of the history and a database change (whose documents are kept
    /// only while they are small) are listed whole.
    pub fn listed_whole(self) -> bool {
        // A statement of the SQL history may be a whole script: listed by its name (its first
        // line) and read when opened.
        !matches!(self, Self::History | Self::Run | Self::SqlHistory)
    }
}
