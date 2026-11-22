//! What kind of operation each one is: where it runs and what it needs.
use super::Operation;

impl Operation {
    /// Operations on the database modules (downloadable drivers), not of the engine.
    pub fn is_module(self) -> bool {
        matches!(
            self,
            Self::ModulesList
                | Self::ModulesInstall
                | Self::ModulesInstallFile
                | Self::ModulesProgress
                | Self::ModulesRemove
        )
    }
    /// Operations on the databases of the modules (`db.*`), not of the engine.
    pub fn is_datasource(self) -> bool {
        matches!(
            self,
            Self::DbTest
                | Self::DbConnect
                | Self::DbDisconnect
                | Self::DbTree
                | Self::DbDescribe
                | Self::DbDdl
                | Self::DbExecute
                | Self::DbFetch
                | Self::DbClose
                | Self::DbCancel
                | Self::DbTransaction
                | Self::DbTransactions
                | Self::DbRowsWrite
                | Self::DbExplain
                | Self::DbImport
                | Self::DbConvert
                | Self::DbCopy
                | Self::DbSearch
                | Self::DbDdlModel
                | Self::DbDdlPlan
                | Self::DbSessions
                | Self::DbLocks
                | Self::DbSessionKill
                | Self::DbDashboards
                | Self::DbDashboardRead
                | Self::DbSplit
                | Self::DbDialect
                | Self::DbCompareSchema
                | Self::DbCompareScript
                | Self::DbCompareData
                | Self::DbSyncData
                | Self::DbRouteTest
                | Self::DbMockRows
        )
    }
    /// Operations on the monitors, which the application schedules, not the engine.
    pub fn is_monitor(self) -> bool {
        matches!(
            self,
            Self::MonitorStatus | Self::MonitorRun | Self::DbTaskRun
        )
    }
    /// Operations with the local client tools of the databases (desktop only), not of the
    /// engine.
    pub fn is_native(self) -> bool {
        matches!(
            self,
            Self::NativeLocate
                | Self::NativeBackup
                | Self::NativeRestore
                | Self::NativeScript
                | Self::NativeStatus
                | Self::NativeCancel
        )
    }
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
                | Self::MongoCompare
                | Self::MongoSync
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
                | Self::MongoSync
        )
    }
    /// Operations whose data belongs to a workspace and need one.
    pub fn needs_workspace(self) -> bool {
        matches!(
            self,
            Self::DatasetQuery
                | Self::SshTest
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
                | Self::MongoSync
                | Self::DbConnect
                | Self::NativeLocate
                | Self::NativeBackup
                | Self::NativeRestore
                | Self::NativeScript
                | Self::MonitorStatus
                | Self::MonitorRun
        )
    }
}
