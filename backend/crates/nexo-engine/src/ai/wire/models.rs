//! The list of a provider's models, a page at a time.
use super::{Call, Settings, encode, key_headers};
use nexo_domain::ai::Provider;
use serde_json::Value;

/// The list of models of the provider: one page (`after` is where the last one ended).
pub fn models(settings: &Settings, after: Option<&str>) -> Call {
    let mut url = match settings.provider {
        Provider::Anthropic => format!("{}/models?limit=1000", settings.base),
        Provider::Gemini => format!("{}/models?pageSize=1000", settings.base),
        Provider::Openai | Provider::Compatible => format!("{}/models", settings.base),
    };
    if let Some(after) = after {
        let name = match settings.provider {
            Provider::Gemini => "pageToken",
            _ => "after_id",
        };
        let joint = if url.contains('?') { '&' } else { '?' };
        url.push_str(&format!("{joint}{name}={}", encode(after)));
    }
    Call {
        url,
        headers: key_headers(settings),
        body: None,
    }
}

/// A model a provider lists.
#[derive(Debug, Clone, PartialEq)]
pub struct Model {
    pub id: String,
    pub name: String,
}

/// The models of a page of the list, and where the next page starts.
pub fn model_page(provider: Provider, body: &Value) -> (Vec<Model>, Option<String>) {
    let text = |value: &Value| value.as_str().unwrap_or_default().to_owned();
    match provider {
        Provider::Gemini => {
            let models = body["models"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|model| {
                    model["supportedGenerationMethods"]
                        .as_array()
                        .is_some_and(|methods| methods.iter().any(|m| m == "generateContent"))
                })
                .map(|model| Model {
                    id: text(&model["name"])
                        .trim_start_matches("models/")
                        .to_owned(),
                    name: text(&model["displayName"]),
                })
                .collect();
            let next = body["nextPageToken"].as_str().map(String::from);
            (models, next.filter(|token| !token.is_empty()))
        }
        _ => {
            let models: Vec<Model> = body["data"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|model| Model {
                    id: text(&model["id"]),
                    name: text(&model["display_name"]),
                })
                .filter(|model| !model.id.is_empty())
                .collect();
            let next = (body["has_more"] == true)
                .then(|| body["last_id"].as_str().map(String::from))
                .flatten();
            (models, next)
        }
    }
}
