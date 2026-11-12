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
    fn restrictive(&self) -> bool {
        matches!(self.egress, Policy::DenyPrivate { .. })
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
            Operation::RunPause => self.runs.pause(id(&payload)),
            Operation::RunResume => self.runs.resume(id(&payload)),
            Operation::Import => interchange::import(&payload),
            Operation::ApiInspect => api_spec::inspect(&payload),
            Operation::ApiDiff => api_spec::compare(&payload),
            Operation::Codegen => interchange::generate(&payload),
            Operation::RealtimeConnect => self.realtime.connect(&payload).await,
            Operation::RealtimeSend => self.realtime.send(&payload),
            Operation::RealtimeClose => self.realtime.disconnect(&payload),
            Operation::RealtimePoll => self.realtime.poll(&payload),
            Operation::RealtimeList => Ok(self.realtime.list()),
            Operation::Grpc => grpc::request(&payload, &self.egress, &self.mocks.ports()).await,
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
            | Operation::MongoProfileEntries => Err(Error::Validation(format!(
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
        self.vault
            .store(name, value, allowed_hosts.map(AllowedHosts::patterns))
            .await
    }
    async fn remove(&self, name: &str) -> Result<()> {
        if oauth2_tokens::is_reserved(name) {
            return Err(invalid("Delete OAuth 2.0 tokens in Manage Tokens"));
        }
        self.vault.remove(name).await
    }
    /// Requests may reference a token's access or ID token, never its details (which hold
    /// the refresh token).
    async fn resolve(&self, name: &str) -> Result<String> {
        if name.trim().starts_with("nexo-oauth2-details:") {
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
            .filter(|(name, _)| !oauth2_tokens::is_reserved(name))
            .map(|(name, allowed_hosts)| SecretSummary {
                name,
                allowed_hosts,
            })
            .collect())
    }
}
