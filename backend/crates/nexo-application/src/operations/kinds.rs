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
        )
    }
}
