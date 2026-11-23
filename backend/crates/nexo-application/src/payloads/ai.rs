//! Payloads of the AI assistant (IA-01). The key is never in them: the application reads it
//! from the vault by the provider's name.
use super::*;

payload! {
    /// A message of a conversation.
    closed AiMessage {
        required {
            role "role": String => "'user' | 'assistant'",
            text "text": String => "string",
        }
        optional {}
    }
}

payload! {
    /// `ai.models`: the models a provider lists.
    closed AiModelsPayload {
        required { provider "provider": String => "'anthropic' | 'openai' | 'gemini' | 'compatible'" }
        optional {
            workspace "workspace": String => "string",
            base_url "baseUrl": String => "string",
            route "route": Map<String, Value> => "{\n    via?: 'direct' | 'http' | 'socks5' | 'ssh';\n    profile?: string;\n  }",
            ca_pem "caPem": String => "string",
        }
    }
}

payload! {
    /// `ai.chat`: the answer to a conversation, streamed and read with `ai.poll`.
    closed AiChatPayload {
        required {
            provider "provider": String => "'anthropic' | 'openai' | 'gemini' | 'compatible'",
            model "model": String => "string",
            messages "messages": Vec<AiMessage> => "readonly AiMessage[]",
        }
        optional {
            workspace "workspace": String => "string",
            base_url "baseUrl": String => "string",
            system "system": String => "string",
            effort "effort": String => "'low' | 'medium' | 'high' | 'xhigh' | 'max'",
            route "route": Map<String, Value> => "{\n    via?: 'direct' | 'http' | 'socks5' | 'ssh';\n    profile?: string;\n  }",
            ca_pem "caPem": String => "string",
        }
    }
}

payload! {
    /// `ai.poll`: what an answer gained after the length `after` already read.
    closed AiPollPayload {
        required { id "id": String => "string" }
        optional {
            workspace "workspace": String => "string",
            after "after": u64 => "number",
        }
    }
}
