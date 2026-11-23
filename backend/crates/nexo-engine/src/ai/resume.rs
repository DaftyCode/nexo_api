//! `ai.continue`: the answers of the tools a model asked for go back to it, after its turn as
//! it gave it, and the answer goes on streaming into the same chat. A model that keeps asking
//! is stopped after a few rounds.
use super::{Assistant, stream, text, wire};
use nexo_domain::{Error, Result};
use serde_json::{Value, json};
use std::time::Instant;

/// Rounds of tools an answer may take.
pub(super) const MAX_ROUNDS: usize = 10;
/// Characters of the answer of one tool sent at most.
const MAX_RESULT: usize = 40_000;

/// The answers of a payload: `[{id, text, error}]`, each cut to its limit.
fn answers(value: &Value) -> Vec<wire::Answer> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| {
            let mut said: String = text(&item["text"]).chars().take(MAX_RESULT).collect();
            if said.is_empty() {
                said = "(nothing)".into();
            }
            wire::Answer {
                id: text(&item["id"]).to_owned(),
                text: said,
                failed: item["error"] == true,
            }
        })
        .collect()
}

impl Assistant {
    /// `ai.continue`: the answers of the tools the chat `id` waits for.
    pub fn resume(&self, payload: &Value) -> Result<Value> {
        let id = text(&payload["id"]);
        let chat = self
            .chats
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or(Error::NotFound)?;
        let answers = answers(&payload["results"]);
        let call = {
            let mut turns = chat.turns.lock().unwrap();
            let Some((native, calls)) = turns.pending.take() else {
                return Err(Error::Validation(
                    "The answer is not waiting for tools".into(),
                ));
            };
            let results = match wire::tools::results(turns.settings.provider, &calls, &answers) {
                Ok(results) => results,
                Err(error) => {
                    turns.pending = Some((native, calls));
                    return Err(error);
                }
            };
            turns.rounds += 1;
            if turns.rounds > MAX_ROUNDS {
                drop(turns);
                let mut state = chat.state.lock().unwrap();
                state.waiting.clear();
                state.stop = Some("tools".into());
                state.done = true;
                state.ended = Some(Instant::now());
                return Ok(json!({"continued": false}));
            }
            turns.native.push(native);
            turns.native.extend(results);
            wire::request(&turns.settings, &turns.native, &turns.system, &turns.tools)?
        };
        {
            let mut state = chat.state.lock().unwrap();
            state.waiting.clear();
            state.ended = None;
            state.separate = true;
            state.separate_thinking = true;
        }
        tokio::spawn(stream::run(chat, call));
        Ok(json!({"continued": true}))
    }
}
