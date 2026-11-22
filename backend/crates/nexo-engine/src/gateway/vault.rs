//! The vault as the application sees it: names reserved for OAuth 2.0 tokens and the key of
//! the masking stay out of its reach.
use super::*;

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
