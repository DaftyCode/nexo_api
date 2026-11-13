//! Operations clients may run, as types. Adding one makes every exhaustive `match` (the
//! engine dispatch) fail to compile until it is handled, and the TypeScript contract test
//! fails until `src/app/application/operations.ts` is regenerated.
use nexo_domain::{Error, Result};

macro_rules! operations {
    ($(#[$meta:meta])* $name:ident, $error:literal, { $($variant:ident => $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum $name {
            $($variant),+
        }
        impl $name {
            pub const ALL: &'static [$name] = &[$(Self::$variant),+];
            pub fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $text),+
                }
            }
            pub fn parse(text: &str) -> Result<Self> {
                match text {
                    $($text => Ok(Self::$variant),)+
                    _ => Err(Error::Validation($error.into())),
                }
            }
        }
        impl std::fmt::Display for $name {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str(self.as_str())
            }
        }
    };
}

operations!(
    /// Execution engine operations.
    Operation, "Unknown execution operation", {
        Request => "request",
        Run => "run",
        RunPause => "run.pause",
        RunResume => "run.resume",
        Cancel => "cancel",
        Import => "import",
        ApiInspect => "api.inspect",
        ApiDiff => "api.diff",
        Codegen => "codegen",
        RealtimeConnect => "realtime.connect",
        RealtimeSend => "realtime.send",
        RealtimeClose => "realtime.close",
        RealtimePoll => "realtime.poll",
        RealtimeList => "realtime.list",
        Grpc => "grpc",
        MockStart => "mock.start",
        MockStop => "mock.stop",
        MockList => "mock.list",
        DatasetQuery => "dataset.query",
        DatasetImport => "dataset.import",
        DatasetSchema => "dataset.schema",
        DatasetParse => "dataset.parse",
        DatasetDelete => "dataset.delete",
        McpRequest => "mcp.request",
        OauthToken => "oauth.token",
        Oauth2Token => "oauth2.token",
        Oauth2Authorize => "oauth2.authorize",
        Oauth2Tokens => "oauth2.tokens",
        CookiesList => "cookies.list",
        CookiesClear => "cookies.clear",
        CookiesSet => "cookies.set",
        CookiesDelete => "cookies.delete",
        Performance => "performance",
        PerformanceCancel => "performance.cancel",
        MongoTest => "mongo.test",
        MongoDatabases => "mongo.databases",
        MongoCollections => "mongo.collections",
        MongoStats => "mongo.stats",
        MongoFind => "mongo.find",
        MongoMore => "mongo.more",
        MongoCount => "mongo.count",
        MongoCancel => "mongo.cancel",
        MongoClose => "mongo.close",
        MongoInsert => "mongo.insert",
        MongoUpdate => "mongo.update",
        MongoReplace => "mongo.replace",
        MongoDelete => "mongo.delete",
        MongoUndo => "mongo.undo",
        MongoCollectionCreate => "mongo.collection.create",
        MongoCollectionRename => "mongo.collection.rename",
        MongoCollectionDrop => "mongo.collection.drop",
        MongoDatabaseDrop => "mongo.database.drop",
        MongoIndexes => "mongo.indexes",
        MongoIndexCreate => "mongo.index.create",
        MongoIndexHide => "mongo.index.hide",
        MongoIndexDrop => "mongo.index.drop",
        MongoExplain => "mongo.explain",
        MongoProfile => "mongo.profile",
        MongoProfileSet => "mongo.profile.set",
        MongoProfileEntries => "mongo.profile.entries",
        MongoImport => "mongo.import",
        MongoAggregate => "mongo.aggregate",
        MongoAggregateWrite => "mongo.aggregate.write",
        MongoSchema => "mongo.schema",
        MongoCollectionValidator => "mongo.collection.validator",
        MongoWatch => "mongo.watch",
        MongoShell => "mongo.shell",
        MongoSql => "mongo.sql",
        MongoCompare => "mongo.compare",
        MongoSync => "mongo.sync",
        ModulesList => "modules.list",
        ModulesInstall => "modules.install",
        ModulesInstallFile => "modules.install.file",
        ModulesProgress => "modules.progress",
        ModulesRemove => "modules.remove",
        DbTest => "db.test",
        DbConnect => "db.connect",
        DbDisconnect => "db.disconnect",
        DbTree => "db.tree",
        DbDescribe => "db.describe",
        DbDdl => "db.ddl",
        DbExecute => "db.execute",
        DbFetch => "db.fetch",
        DbClose => "db.close",
        DbCancel => "db.cancel",
        DbTransaction => "db.transaction",
        DbSplit => "db.split",
        DbDialect => "db.dialect",
    }
);

operations!(
    /// Git operations on a workspace project, local and with its remotes.
    GitOperation, "Unsupported Git operation", {
        Init => "init",
        Status => "status",
        Diff => "diff",
        Log => "log",
        Branches => "branches",
        Checkout => "checkout",
        Branch => "branch",
        Commit => "commit",
        Stash => "stash",
        Export => "export",
        Files => "files",
        RemoteList => "remote.list",
        RemoteAdd => "remote.add",
        RemoteRemove => "remote.remove",
        Fetch => "fetch",
        Pull => "pull",
        Push => "push",
        Clone => "clone",
    }
);

mod contract;
mod kinds;
#[cfg(test)]
mod tests;

pub use contract::typescript_contract;
