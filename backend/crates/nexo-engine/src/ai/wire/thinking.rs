//! Which models are asked to show their reasoning. Anthropic's adaptive thinking omits its
//! text unless a summary is asked for, and a model before it refuses the field; Gemini adds
//! its thoughts to the stream when asked, from 2.5. llama.cpp and the servers compatible
//! with OpenAI send the reasoning without being asked; OpenAI's own API never sends it.

/// The leading numbers of a model name, `5-5` in `opus-5-5-20261001` as (5, 5).
fn version<'a>(parts: impl Iterator<Item = &'a str>) -> (u32, u32) {
    let mut numbers =
        parts.map_while(|part| (part.len() <= 2).then(|| part.parse::<u32>().ok())?);
    (
        numbers.next().unwrap_or_default(),
        numbers.next().unwrap_or_default(),
    )
}

/// Whether an Anthropic model thinks adaptively: Opus and Sonnet from 4.6, Haiku from 5,
/// Fable and Mythos.
pub fn anthropic_adaptive(model: &str) -> bool {
    let mut parts = model.trim().trim_start_matches("claude-").split('-');
    match parts.next().unwrap_or_default() {
        "fable" | "mythos" => true,
        "opus" | "sonnet" => version(parts) >= (4, 6),
        "haiku" => version(parts) >= (5, 0),
        _ => false,
    }
}

/// Whether a Gemini model thinks: from 2.5, and the `-latest` names of Flash and Pro.
pub fn gemini_thinks(model: &str) -> bool {
    let Some(name) = model
        .trim()
        .trim_start_matches("models/")
        .strip_prefix("gemini-")
    else {
        return false;
    };
    let first = name.split('-').next().unwrap_or_default();
    match version(first.split('.')) {
        (0, _) => matches!(first, "flash" | "pro") && name.ends_with("-latest"),
        found => found >= (2, 5),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_models_that_take_it_are_asked_for_their_reasoning() {
        for model in [
            "claude-opus-5-5",
            "claude-opus-5",
            "claude-opus-4-6",
            "claude-sonnet-5-5",
            "claude-sonnet-4-6-20260101",
            "claude-haiku-5-5",
            "claude-fable-5-2",
        ] {
            assert!(anthropic_adaptive(model), "{model}");
        }
        for model in [
            "claude-opus-4-5",
            "claude-opus-4-1-20250805",
            "claude-haiku-4-5-20251001",
            "claude-3-5-sonnet-20241022",
            "",
        ] {
            assert!(!anthropic_adaptive(model), "{model}");
        }
        for model in [
            "gemini-2.5-pro",
            "models/gemini-2.5-flash-lite",
            "gemini-3-pro-preview",
            "gemini-flash-latest",
        ] {
            assert!(gemini_thinks(model), "{model}");
        }
        for model in [
            "gemini-2.0-flash",
            "gemini-1.5-pro",
            "gemma-3-27b-it",
            "gemini-x",
        ] {
            assert!(!gemini_thinks(model), "{model}");
        }
    }
}
