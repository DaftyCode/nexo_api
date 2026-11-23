//! The AI assistant (IA-01): the providers a person reaches with a key of their own, the
//! messages of a conversation and the limits of what is sent. Nothing passes through a server
//! of Nexo: the call goes from the person's computer to the provider they chose.
use crate::{Error, Result};
use serde::{Deserialize, Serialize};

/// Messages a conversation sends at most.
pub const MAX_MESSAGES: usize = 200;
/// Characters a conversation sends at most, its instructions included.
pub const MAX_CHARACTERS: usize = 400_000;

/// Who answers: a provider with its own API, or any server that speaks OpenAI's (Mistral,
/// DeepSeek, Groq, OpenRouter, Azure OpenAI, a server of the person's own).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Anthropic,
    Openai,
    Gemini,
    Compatible,
}

impl Provider {
    pub const ALL: [Provider; 4] = [
        Self::Anthropic,
        Self::Openai,
        Self::Gemini,
        Self::Compatible,
    ];
    pub fn parse(text: &str) -> Result<Self> {
        Self::ALL
            .into_iter()
            .find(|provider| provider.as_str() == text)
            .ok_or_else(|| Error::Validation(format!("Nexo has no AI provider {text}")))
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
            Self::Openai => "openai",
            Self::Gemini => "gemini",
            Self::Compatible => "compatible",
        }
    }
    /// The vault secret that keeps the provider's key: `ai:anthropic`.
    pub fn key_name(self) -> String {
        format!("ai:{}", self.as_str())
    }
    /// A server compatible with OpenAI may take no key (a server of one's own).
    pub fn needs_key(self) -> bool {
        self != Self::Compatible
    }
    /// Where its API is: the provider's own, or the address written for a compatible server
    /// (`https://api.mistral.ai/v1`), without a trailing slash.
    pub fn base_url(self, written: Option<&str>) -> Result<String> {
        let written = written.map(str::trim).filter(|url| !url.is_empty());
        let url = match (self, written) {
            (Self::Anthropic, None) => "https://api.anthropic.com/v1",
            (Self::Openai, None) => "https://api.openai.com/v1",
            (Self::Gemini, None) => "https://generativelanguage.googleapis.com/v1beta",
            (Self::Compatible, None) => {
                return Err(Error::Validation(
                    "Write the address of the server, such as https://api.mistral.ai/v1".into(),
                ));
            }
            (_, Some(url)) => url,
        };
        let lower = url.to_ascii_lowercase();
        if !(lower.starts_with("https://") || lower.starts_with("http://"))
            || url.contains(char::is_whitespace)
        {
            return Err(Error::Validation(format!(
                "{url} is not the address of an API (http:// or https://)"
            )));
        }
        Ok(url.trim_end_matches('/').to_owned())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    pub text: String,
}

/// How much a model thinks before it answers, where the provider has the setting.
pub fn effort(text: Option<&str>) -> Result<Option<&'static str>> {
    match text.map(str::trim).filter(|text| !text.is_empty()) {
        None => Ok(None),
        Some(text) => ["low", "medium", "high", "xhigh", "max"]
            .into_iter()
            .find(|level| *level == text)
            .map(Some)
            .ok_or_else(|| Error::Validation(format!("{text} is not a level of effort"))),
    }
}

/// A conversation ready to send: it ends with what the person asks, it is not empty and it
/// stays within the limits. Consecutive messages of the same author are joined, as every
/// provider wants turns that alternate.
pub fn conversation(messages: Vec<Message>, system: Option<&str>) -> Result<Vec<Message>> {
    if messages.len() > MAX_MESSAGES {
        return Err(Error::Validation(format!(
            "A conversation sends at most {MAX_MESSAGES} messages: start a new one"
        )));
    }
    let characters = messages
        .iter()
        .map(|message| message.text.chars().count())
        .sum::<usize>()
        + system.map_or(0, |system| system.chars().count());
    if characters > MAX_CHARACTERS {
        return Err(Error::Validation(format!(
            "A conversation sends at most {MAX_CHARACTERS} characters: start a new one"
        )));
    }
    let mut joined: Vec<Message> = Vec::new();
    for message in messages {
        if message.text.trim().is_empty() {
            continue;
        }
        match joined.last_mut() {
            Some(last) if last.role == message.role => {
                last.text.push_str("\n\n");
                last.text.push_str(&message.text);
            }
            _ => joined.push(message),
        }
    }
    // A conversation opens with the person's words.
    while joined.first().is_some_and(|first| first.role != Role::User) {
        joined.remove(0);
    }
    if joined.last().is_none_or(|last| last.role != Role::User) {
        return Err(Error::Validation("Write what you want to ask".into()));
    }
    Ok(joined)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn said(role: Role, text: &str) -> Message {
        Message {
            role,
            text: text.into(),
        }
    }

    #[test]
    fn providers_have_their_address_and_their_key() {
        assert_eq!(Provider::parse("gemini").unwrap(), Provider::Gemini);
        assert!(Provider::parse("other").is_err());
        assert_eq!(Provider::Anthropic.key_name(), "ai:anthropic");
        assert!(!Provider::Compatible.needs_key());
        assert_eq!(
            Provider::Openai.base_url(None).unwrap(),
            "https://api.openai.com/v1"
        );
        assert_eq!(
            Provider::Compatible
                .base_url(Some(" http://127.0.0.1:8080/v1/ "))
                .unwrap(),
            "http://127.0.0.1:8080/v1"
        );
        assert!(Provider::Compatible.base_url(None).is_err());
        assert!(Provider::Compatible.base_url(Some("file:///etc")).is_err());
        assert!(Provider::Openai.base_url(Some("https://a b")).is_err());
    }

    #[test]
    fn effort_is_one_of_its_levels() {
        assert_eq!(effort(None).unwrap(), None);
        assert_eq!(effort(Some(" ")).unwrap(), None);
        assert_eq!(effort(Some("high")).unwrap(), Some("high"));
        assert!(effort(Some("extreme")).is_err());
    }

    #[test]
    fn a_conversation_alternates_and_ends_with_a_question() {
        let joined = conversation(
            vec![
                said(Role::Assistant, "Hello"),
                said(Role::User, "One"),
                said(Role::User, "Two"),
                said(Role::Assistant, " "),
                said(Role::Assistant, "Answer"),
                said(Role::User, "Three"),
            ],
            Some("Be brief"),
        )
        .unwrap();
        assert_eq!(
            joined,
            [
                said(Role::User, "One\n\nTwo"),
                said(Role::Assistant, "Answer"),
                said(Role::User, "Three"),
            ]
        );
        assert!(
            conversation(
                vec![said(Role::User, "Hi"), said(Role::Assistant, "Yes")],
                None
            )
            .is_err()
        );
        assert!(conversation(Vec::new(), None).is_err());
        let many = vec![said(Role::User, "x"); MAX_MESSAGES + 1];
        assert!(conversation(many, None).is_err());
        let long = vec![said(Role::User, &"x".repeat(MAX_CHARACTERS + 1))];
        assert!(conversation(long, None).is_err());
    }
}
