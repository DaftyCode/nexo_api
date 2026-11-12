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
    }
);
impl Operation {
    /// Operations of the document database adapter (MongoDB), not of the engine.
    pub fn is_database(self) -> bool {
        matches!(
            self,
            Self::MongoTest
                | Self::MongoDatabases
                | Self::MongoCollections
                | Self::MongoStats
                | Self::MongoFind
                | Self::MongoMore
                | Self::MongoCount
                | Self::MongoCancel
                | Self::MongoClose
                | Self::MongoInsert
                | Self::MongoUpdate
                | Self::MongoReplace
                | Self::MongoDelete
                | Self::MongoUndo
                | Self::MongoCollectionCreate
                | Self::MongoCollectionRename
                | Self::MongoCollectionDrop
                | Self::MongoDatabaseDrop
                | Self::MongoIndexes
                | Self::MongoIndexCreate
                | Self::MongoIndexHide
                | Self::MongoIndexDrop
                | Self::MongoExplain
                | Self::MongoProfile
                | Self::MongoProfileSet
                | Self::MongoProfileEntries
                | Self::MongoImport
                | Self::MongoAggregate
                | Self::MongoAggregateWrite
                | Self::MongoSchema
                | Self::MongoCollectionValidator
                | Self::MongoWatch
        )
    }
    /// Database operations that change data or the server's settings: refused on a
    /// read-only connection. Writes of documents are also recorded so they can be undone.
    pub fn is_database_write(self) -> bool {
        matches!(
            self,
            Self::MongoInsert
                | Self::MongoUpdate
                | Self::MongoReplace
                | Self::MongoDelete
                | Self::MongoUndo
                | Self::MongoCollectionCreate
                | Self::MongoCollectionRename
                | Self::MongoCollectionDrop
                | Self::MongoDatabaseDrop
                | Self::MongoIndexCreate
                | Self::MongoIndexHide
                | Self::MongoIndexDrop
                | Self::MongoProfileSet
                | Self::MongoImport
                | Self::MongoAggregateWrite
                | Self::MongoCollectionValidator
        )
    }
    /// Operations whose data belongs to a workspace and need one.
    pub fn needs_workspace(self) -> bool {
        matches!(
            self,
            Self::DatasetQuery
                | Self::DatasetImport
                | Self::DatasetSchema
                | Self::DatasetDelete
                | Self::CookiesList
                | Self::CookiesClear
                | Self::CookiesSet
                | Self::CookiesDelete
                | Self::MongoInsert
                | Self::MongoUpdate
                | Self::MongoReplace
                | Self::MongoDelete
                | Self::MongoUndo
                | Self::MongoCollectionCreate
                | Self::MongoCollectionRename
                | Self::MongoCollectionDrop
                | Self::MongoDatabaseDrop
                | Self::MongoIndexCreate
                | Self::MongoIndexHide
                | Self::MongoIndexDrop
                | Self::MongoProfileSet
                | Self::MongoCollectionValidator
                | Self::MongoShell
        )
    }
}

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

/// The TypeScript contract written to `src/app/application/operations.ts`.
pub fn typescript_contract() -> String {
    fn list(name: &str, items: Vec<&str>) -> String {
        let quoted: Vec<String> = items.iter().map(|item| format!("'{item}'")).collect();
        let single = format!("export const {name} = [{}] as const;", quoted.join(", "));
        if single.len() <= 100 {
            format!("{single}\n")
        } else {
            let lines: String = quoted.iter().map(|item| format!("  {item},\n")).collect();
            format!("export const {name} = [\n{lines}] as const;\n")
        }
    }
    format!(
        "// Generated from backend/crates/nexo-application/src/operations.rs.\n\
         // Regenerate with `NEXO_UPDATE_CONTRACTS=1 cargo test -p nexo-application`.\n\
         {}export type ExecutionOperation = (typeof EXECUTION_OPERATIONS)[number];\n\
         {}export type GitOperation = (typeof GIT_OPERATIONS)[number];\n",
        list(
            "EXECUTION_OPERATIONS",
            Operation::ALL.iter().map(|o| o.as_str()).collect()
        ),
        list(
            "GIT_OPERATIONS",
            GitOperation::ALL.iter().map(|o| o.as_str()).collect()
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn operations_round_trip_and_reject_unknown_names() {
        for operation in Operation::ALL {
            assert_eq!(Operation::parse(operation.as_str()).unwrap(), *operation);
        }
        for operation in GitOperation::ALL {
            assert_eq!(GitOperation::parse(operation.as_str()).unwrap(), *operation);
        }
        assert!(Operation::parse("shell.exec").is_err());
        assert!(Operation::parse("vault.get").is_err());
        // Only the operations Nexo runs itself: never arbitrary Git commands.
        for name in ["config", "gc", "remote", "submodule", "filter-branch"] {
            assert!(GitOperation::parse(name).is_err(), "{name}");
        }
    }
    #[test]
    fn typescript_contract_is_current() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../src/app/application/operations.ts");
        let expected = typescript_contract();
        if std::env::var_os("NEXO_UPDATE_CONTRACTS").is_some() {
            std::fs::write(&path, &expected).unwrap();
        }
        let current = std::fs::read_to_string(&path)
            .unwrap_or_default()
            .replace("\r\n", "\n");
        assert_eq!(
            current, expected,
            "operations.ts is out of date; run NEXO_UPDATE_CONTRACTS=1 cargo test -p nexo-application"
        );
    }
}
