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
    /// A collection, or a folder of it, run on a schedule while Nexo is open (`monitor`).
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
    /// A saved entity-relationship diagram of a SQL connection: its tables, where each one
    /// is drawn and its color, its notes, and how it is drawn.
    #[serde(rename = "db-diagram")]
    DbDiagram,
    /// What a workspace shows when it opens again: its open tabs with their unsaved changes
    /// (the files chosen for them by name only), the active tab, the section shown and the
    /// order of its collections. Never responses.
    Session,
    /// A reusable SSH profile to reach servers through a bastion: host, port, user and how it
    /// signs in; its password or private key (and passphrase) stay in the vault.
    #[serde(rename = "ssh-profile")]
    SshProfile,
    /// The last runs of a monitor (`monitor`), newest first: when each one started, how long
    /// it took, its state and its failed assertions, never its responses. One per monitor.
    #[serde(rename = "monitor-history")]
    MonitorHistory,
    /// A set of masking rules: the fields it hides or replaces when data is exported, and
    /// whether MCP agents and the AI assistant read through it too (`masking`).
    Masking,
    /// A type of SQL connection of the person's own, besides development, test and
    /// production: its color and what its sessions do (confirm writes or DDL, commit by hand,
    /// only read, a time limit).
    #[serde(rename = "connection-type")]
    ConnectionType,
    /// A reusable HTTP or SOCKS5 proxy: host, port, user and whether it resolves names; its
    /// password stays in the vault.
    #[serde(rename = "proxy-profile")]
    ProxyProfile,
    /// A saved database task (DB-31): scripts, a copy, a comparison, a backup or other tasks,
    /// with what it authorizes and when it runs. Its runs go in a `monitor-history`.
    #[serde(rename = "db-task")]
    DbTask,
    /// A conversation with the AI assistant (IA-01): what the person asked and what it
    /// answered, never the key nor a value of the vault. It only grows: its last state matters.
    #[serde(rename = "ai-conversation")]
    AiConversation,
    /// A collection shared by the team (C-01): where its file is (a synced folder), whether
    /// it is encrypted and with which team key of the vault, the environments shared with
    /// it, and the collection as last synced, to join two people's changes. Only its last
    /// state matters.
    #[serde(rename = "shared-link")]
    SharedLink,
}
impl DocumentKind {
    pub const ALL: [DocumentKind; 30] = [
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
        Self::DbDiagram,
        Self::Session,
        Self::SshProfile,
        Self::MonitorHistory,
        Self::Masking,
        Self::ConnectionType,
        Self::ProxyProfile,
        Self::DbTask,
        Self::AiConversation,
        Self::SharedLink,
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
            Self::DbDiagram => "db-diagram",
            Self::Session => "session",
            Self::SshProfile => "ssh-profile",
            Self::MonitorHistory => "monitor-history",
            Self::Masking => "masking",
            Self::ConnectionType => "connection-type",
            Self::ProxyProfile => "proxy-profile",
            Self::DbTask => "db-task",
            Self::AiConversation => "ai-conversation",
            Self::SharedLink => "shared-link",
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
                | Self::MonitorHistory
                | Self::AiConversation
                | Self::SharedLink
        )
    }
    /// Request history and run reports grow with use, so a workspace lists them without
    /// their values; a query of the history and a database change (whose documents are kept
    /// only while they are small) are listed whole.
    pub fn listed_whole(self) -> bool {
        // A statement of the SQL history may be a whole script: listed by its name (its first
        // line) and read when opened.
        // The history of a monitor is read when the monitor is opened.
        !matches!(
            self,
            Self::History
                | Self::Run
                | Self::SqlHistory
                | Self::MonitorHistory
                | Self::AiConversation
                | Self::SharedLink
        )
    }
}
