//! An answer read from its stream into its chat, until it ends, fails or is stopped.
use super::{
    Chat, MAX_ANSWER, TIMEOUT,
    wire::{self, Call, Delta},
};
use crate::{
    graphql_sse::{Event, Parser},
    transport::{Transport, read_limited, request_error},
};
use nexo_domain::ai::Provider;
use std::{sync::Arc, time::Instant};
use url::Url;

pub(super) async fn run(
    chat: Arc<Chat>,
    transport: Transport,
    url: Url,
    call: Call,
    provider: Provider,
) {
    let outcome = tokio::select! {
        _ = chat.stop.cancelled() => Ok(Some("stopped".to_owned())),
        streamed = tokio::time::timeout(TIMEOUT, stream(&chat, &transport, &url, &call, provider)) => {
            streamed.unwrap_or_else(|_| Err("The answer took too long".to_owned()))
        }
    };
    let mut state = chat.state.lock().unwrap();
    match outcome {
        Ok(Some(stop)) => state.stop = Some(stop),
        Ok(None) => {}
        Err(error) => state.error = Some(error),
    }
    state.done = true;
    state.ended = Some(Instant::now());
}

/// Applies the deltas of an event; `Some` with the reason when the answer must end here.
fn apply(
    chat: &Chat,
    provider: Provider,
    event: &Event,
) -> std::result::Result<Option<String>, String> {
    let mut state = chat.state.lock().unwrap();
    for delta in wire::deltas(provider, event) {
        match delta {
            Delta::Text(text) => {
                if state.text.len() + text.len() > MAX_ANSWER {
                    return Ok(Some("length".into()));
                }
                state.text.push_str(&text);
            }
            // Reasoning past the limit of an answer is left out; the answer goes on.
            Delta::Thinking(text) => {
                if state.thinking.len() + text.len() <= MAX_ANSWER {
                    state.thinking.push_str(&text);
                }
            }
            Delta::Stop(stop) => state.stop = Some(stop),
            Delta::Usage { input, output } => {
                state.input = state.input.max(input);
                state.output = state.output.max(output);
            }
            Delta::Failed(error) => return Err(error),
        }
    }
    Ok(None)
}

async fn stream(
    chat: &Chat,
    transport: &Transport,
    url: &Url,
    call: &Call,
    provider: Provider,
) -> std::result::Result<Option<String>, String> {
    let body = call.body.clone().unwrap_or_default();
    let mut response = transport
        .stream(url, &call.headers, body)
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        let retry = response
            .headers()
            .get("retry-after")
            .and_then(|value| value.to_str().ok())
            .map(String::from);
        let text = read_limited(response, 64 * 1024).await.unwrap_or_default();
        return Err(wire::failure(status, &text, retry.as_deref()));
    }
    let mut parser = Parser::default();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| request_error(error).to_string())?
    {
        for event in parser.push(&chunk) {
            if let Some(stop) = apply(chat, provider, &event)? {
                return Ok(Some(stop));
            }
        }
    }
    // A last event the server did not end with a blank line.
    for event in parser.push(b"\n\n") {
        if let Some(stop) = apply(chat, provider, &event)? {
            return Ok(Some(stop));
        }
    }
    Ok(None)
}
