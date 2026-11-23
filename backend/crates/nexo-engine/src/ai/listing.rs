//! `ai.models`: the models a provider lists for the key, page after page.
use super::{Assistant, settings, wire};
use crate::transport::{parse_url, read_limited};
use nexo_domain::{Error, Result};
use serde_json::{Value, json};

/// Pages of a list of models read at most.
const MODEL_PAGES: usize = 10;

impl Assistant {
    /// `ai.models`: the models the provider lists for the key.
    pub async fn models(&self, payload: &Value) -> Result<Value> {
        let settings = settings(payload)?;
        let first = wire::models(&settings, None);
        let transport = self.transport(&parse_url(&first.url)?, payload).await?;
        let mut found: Vec<wire::Model> = Vec::new();
        let mut call = first;
        for _ in 0..MODEL_PAGES {
            let response = transport.get(&parse_url(&call.url)?, &call.headers).await?;
            let status = response.status().as_u16();
            let body = read_limited(response, 8 * 1024 * 1024).await?;
            if !(200..300).contains(&status) {
                return Err(Error::Validation(wire::failure(status, &body, None)));
            }
            let body: Value = serde_json::from_str(&body).map_err(|_| {
                Error::Validation("The provider did not answer a list of models".into())
            })?;
            let (page, next) = wire::model_page(settings.provider, &body);
            for model in page {
                if !found.iter().any(|seen| seen.id == model.id) {
                    found.push(model);
                }
            }
            match next {
                Some(after) => call = wire::models(&settings, Some(&after)),
                None => break,
            }
        }
        let models: Vec<Value> = found
            .iter()
            .map(|model| json!({"id": model.id, "name": model.name}))
            .collect();
        Ok(json!({"models": models}))
    }
}
