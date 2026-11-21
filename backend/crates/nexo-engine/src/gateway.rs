//! The application ports the engine implements: execution, the vault and the egress policy.
use super::*;

#[async_trait]
impl nexo_application::ports::NetworkPolicy for Engine {
    async fn check_destination(&self, host: &str, port: u16) -> Result<()> {
        self.egress
            .resolve(host, port, &self.mocks.ports())
            .await
            .map(|_| ())
    }
    async fn resolve_destination(
        &self,
        host: &str,
        port: u16,
    ) -> Result<Vec<std::net::SocketAddr>> {
        self.egress.resolve(host, port, &self.mocks.ports()).await
    }
    fn restrictive(&self) -> bool {
        matches!(self.egress, Policy::DenyPrivate { .. })
    }
    async fn socks_proxy(
        &self,
        route: &nexo_application::ports::ConnectionRoute,
    ) -> Result<Option<nexo_application::ports::SocksProxy>> {
        let route =
            crate::route::Route::with_profiles(&json!({"route": route.route}), &route.profiles)?;
        crate::route::Dialer::new(route, self.egress.clone(), self.mocks.ports())
            .socks_proxy()
            .await
    }
    async fn check_routed_destination(&self, host: &str, port: u16) -> Result<()> {
        self.egress
            .check_remote(host, port, &self.mocks.ports())
            .await
    }
    async fn forward(
        &self,
        route: &nexo_application::ports::ConnectionRoute,
        host: &str,
        port: u16,
    ) -> Result<nexo_application::ports::Forwarded> {
        let route =
            crate::route::Route::with_profiles(&json!({"route": route.route}), &route.profiles)?;
        match route {
            crate::route::Route::Direct => {
                return Err(Error::Validation(
                    "This connection goes straight to its server: there is nothing to forward"
                        .into(),
                ));
            }
            crate::route::Route::Http { .. } => {
                return Err(Error::Validation(
                    "This connection cannot go through an HTTP proxy: choose a SOCKS5 proxy or an SSH tunnel"
                        .into(),
                ));
            }
            _ => {}
        }
        let dialer = crate::route::Dialer::new(route, self.egress.clone(), self.mocks.ports());
        let forward = crate::route::forward::open(dialer, host.to_string(), port).await?;
        Ok(nexo_application::ports::Forwarded {
            address: forward.address,
            open: Box::new(forward),
        })
    }
}

#[async_trait]
impl ExecutionGateway for Engine {
    async fn execute(&self, operation: Operation, payload: Value) -> Result<Value> {
        let payload = self.with_secret_hosts(payload).await?;
        match operation {
            Operation::Request => {
                let payload = self.prepare_oauth2(payload).await;
                self.runs.request(payload, true).await
            }
            Operation::Run if payload["action"] == "status" => self
                .runs
                .status(id(&payload), &runner::Cursor::from_value(&payload["after"])),
            Operation::Run => {
                let payload = self.prepare_oauth2(payload).await;
                let job = self.runs.start(payload)?;
                Ok(json!({"id": job.id(), "state": "running"}))
            }
            Operation::Cancel => self.runs.cancel(id(&payload)),
            Operation::MongoShell => shell::run(self.databases.clone(), payload).await,
            Operation::MongoSql => sql::translate(payload["sql"].as_str().unwrap_or_default()),
            Operation::RunPause => self.runs.pause(id(&payload)),
            Operation::RunResume => self.runs.resume(id(&payload)),
            Operation::Import => interchange::import(&payload),
            Operation::ApiInspect => api_spec::inspect(&payload),
            Operation::ApiDiff => api_spec::compare(&payload),
            Operation::ResponseCompare => compare::responses(&payload),
            Operation::SchemaInfer => compare::infer_schema(&payload),
            Operation::MaskApply => masking::apply(&self.vault, &payload).await,
            Operation::Codegen => interchange::generate(&payload),
            Operation::RealtimeConnect => self.realtime.connect(&payload).await,
            Operation::RealtimeSend => self.realtime.send(&payload),
            Operation::RealtimeClose => self.realtime.disconnect(&payload),
            Operation::RealtimePoll => self.realtime.poll(&payload),
            Operation::RealtimeList => Ok(self.realtime.list()),
            Operation::Grpc => grpc::request(&payload, &self.egress, &self.mocks.ports()).await,
            Operation::SshTest => {
                crate::route::ssh::test_profile(&payload, &self.egress, &self.mocks.ports()).await
            }
            Operation::SshTrust => crate::route::ssh::trust_key(&payload),
            Operation::MockStart => self.mocks.start(&payload).await,
            Operation::MockStop => self.mocks.stop(&payload),
            Operation::MockList => Ok(self.mocks.list()),
            Operation::DatasetImport => self.datasets.import(&payload),
            Operation::DatasetQuery => self.dataset_query(payload).await,
            Operation::DatasetSchema => {
                let mut payload = payload;
                payload["sql"] = json!("SELECT * FROM data LIMIT 1");
                self.dataset_query(payload).await
            }
            Operation::DatasetDelete => self.datasets.remove(&payload),
            Operation::DatasetParse => {
                let rows = datasets::parse_rows(&payload)?;
                let total = rows.len();
                Ok(
                    json!({"rows": rows.into_iter().take(10_000).collect::<Vec<_>>(), "total": total}),
                )
            }
            Operation::McpRequest => self.mcp(&payload).await,
            Operation::OauthToken => self.oauth_token(&payload).await,
            Operation::Oauth2Token => self.oauth2_token(&payload).await,
            Operation::Oauth2Authorize => self.oauth2_authorize(&payload).await,
            Operation::Oauth2Tokens => self.oauth2_tokens(&payload).await,
            Operation::CookiesList => {
                Ok(json!({"cookies": self.runs.jars.list(&cookie_scope(&payload))}))
            }
            Operation::CookiesClear => {
                self.runs.jars.clear(&cookie_scope(&payload));
                Ok(json!({"cleared": true}))
            }
            Operation::CookiesSet => Ok(json!({
                "cookie": self.runs.jars.set(&cookie_scope(&payload), &payload)?
            })),
            Operation::CookiesDelete => Ok(json!({
                "deleted": self.runs.jars.delete(
                    &cookie_scope(&payload),
                    payload["domain"].as_str().unwrap_or(""),
                    payload["path"].as_str().unwrap_or(""),
                    payload["name"].as_str().unwrap_or(""),
                )
            })),
            Operation::Performance if payload["action"] == "status" => {
                self.performance.status(id(&payload))
            }
            Operation::Performance => self.performance.start(&payload),
            Operation::PerformanceCancel => self.performance.cancel(id(&payload)),
            // The application sends these to the document database adapter, never here.
            Operation::MongoTest
            | Operation::MongoDatabases
            | Operation::MongoCollections
            | Operation::MongoStats
            | Operation::MongoFind
            | Operation::MongoMore
            | Operation::MongoCount
            | Operation::MongoCancel
            | Operation::MongoClose
            | Operation::MongoInsert
            | Operation::MongoUpdate
            | Operation::MongoReplace
            | Operation::MongoDelete
            | Operation::MongoUndo
            | Operation::MongoCollectionCreate
            | Operation::MongoCollectionRename
            | Operation::MongoCollectionDrop
            | Operation::MongoDatabaseDrop
            | Operation::MongoIndexes
            | Operation::MongoIndexCreate
            | Operation::MongoIndexHide
            | Operation::MongoIndexDrop
            | Operation::MongoExplain
            | Operation::MongoProfile
            | Operation::MongoProfileSet
            | Operation::MongoProfileEntries
            | Operation::MongoImport
            | Operation::MongoAggregate
            | Operation::MongoAggregateWrite
            | Operation::MongoSchema
            | Operation::MongoCollectionValidator
            | Operation::MongoWatch
            | Operation::MongoCompare
            | Operation::MongoSync
            // The application sends these to the database modules.
            | Operation::ModulesList
            | Operation::ModulesInstall
            | Operation::ModulesInstallFile
            | Operation::ModulesProgress
            | Operation::ModulesRemove
            | Operation::DbTest
            | Operation::DbConnect
            | Operation::DbDisconnect
            | Operation::DbTree
            | Operation::DbDescribe
            | Operation::DbDdl
            | Operation::DbExecute
            | Operation::DbFetch
            | Operation::DbClose
            | Operation::DbCancel
            | Operation::DbTransaction
            | Operation::DbTransactions
            | Operation::DbRowsWrite
            | Operation::DbExplain
            | Operation::DbImport
            | Operation::DbConvert
            | Operation::DbCopy
            | Operation::DbSearch
            | Operation::DbDdlModel
            | Operation::DbDdlPlan
            | Operation::DbSessions
            | Operation::DbLocks
            | Operation::DbSessionKill
            | Operation::DbDashboards
            | Operation::DbDashboardRead
            | Operation::DbSplit
            | Operation::DbDialect
            | Operation::DbCompareSchema
            | Operation::DbCompareScript
            | Operation::DbCompareData
            | Operation::DbSyncData
            | Operation::DbRouteTest
            // The application schedules the monitors and runs them through `run`.
            | Operation::MonitorStatus
            | Operation::MonitorRun
            // The application runs the local client tools through its adapter.
            | Operation::NativeLocate
            | Operation::NativeBackup
            | Operation::NativeRestore
            | Operation::NativeScript
            | Operation::NativeStatus
            | Operation::NativeCancel
            => Err(Error::Validation(format!(
                "{operation} is not an operation of the execution engine"
            ))),
        }
    }
}

#[async_trait]
impl SecretVault for Engine {
    /// OAuth 2.0 tokens are kept under reserved names, managed only through `oauth2.tokens`.
    async fn put(
        &self,
        name: &str,
        value: Option<&str>,
        allowed_hosts: Option<&AllowedHosts>,
    ) -> Result<()> {
        if oauth2_tokens::is_reserved(name) {
            return Err(invalid(
                "Names starting with nexo-oauth2 are reserved for OAuth 2.0 tokens",
            ));
        }
        if masking::is_reserved(name) {
            return Err(invalid("Names starting with nexo-masking are reserved"));
        }
        self.vault
            .store(name, value, allowed_hosts.map(AllowedHosts::patterns))
            .await
    }
    async fn remove(&self, name: &str) -> Result<()> {
        if oauth2_tokens::is_reserved(name) {
            return Err(invalid("Delete OAuth 2.0 tokens in Manage Tokens"));
        }
        if masking::is_reserved(name) {
            return Err(invalid("Names starting with nexo-masking are reserved"));
        }
        self.vault.remove(name).await
    }
    /// Requests may reference a token's access or ID token, never its details (which hold
    /// the refresh token).
    async fn resolve(&self, name: &str) -> Result<String> {
        // The key of the masking never leaves the engine either.
        if name.trim().starts_with("nexo-oauth2-details:") || masking::is_reserved(name) {
            return Err(Error::NotFound);
        }
        self.vault.get(name).await
    }
    async fn secrets(&self) -> Result<Vec<SecretSummary>> {
        Ok(self
            .vault
            .hosts()
            .await?
            .into_iter()
            .filter(|(name, _)| !oauth2_tokens::is_reserved(name) && !masking::is_reserved(name))
            .map(|(name, allowed_hosts)| SecretSummary {
                name,
                allowed_hosts,
            })
            .collect())
    }
}
