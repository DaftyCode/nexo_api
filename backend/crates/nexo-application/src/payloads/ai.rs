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
        required { provider "provider": String => "'anthropic' | 'openai' | 'gemini' | 'compatible' | 'local'" }
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
            provider "provider": String => "'anthropic' | 'openai' | 'gemini' | 'compatible' | 'local'",
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
            tools "tools": String => "'request' | 'sql' | 'mongo'",
        }
    }
}

payload! {
    /// `ai.tool`: a tool the model asked for, read with what the person has open (`context`).
    /// Response bodies are left out when `bodies` is `false`.
    closed AiToolPayload {
        required { name "name": String => "string" }
        optional {
            workspace "workspace": String => "string",
            input "input": Map<String, Value> => "Record<string, unknown>",
            context "context": AiContext => "AiContext",
            bodies "bodies": bool => "boolean",
        }
    }
}

payload! {
    /// What the person has open beside the assistant, for its tools to read.
    closed AiContext {
        required {}
        optional {
            place "place": String => "'request' | 'sql' | 'mongo'",
            request "request": Map<String, Value> => "Record<string, unknown>",
            response "response": Map<String, Value> => "Record<string, unknown>",
            collection_id "collectionId": String => "string",
            connection "connection": String => "string",
            connection_id "connectionId": String => "string",
            engine "engine": String => "string",
            database "database": String => "string",
            collection "collection": String => "string",
            script "script": String => "string",
            query "query": String => "string",
            error "error": String => "string",
            plan "plan": String => "string",
        }
    }
}

payload! {
    /// What a tool gave the model: its text, and whether it failed.
    closed AiToolResult {
        required {
            id "id": String => "string",
            text "text": String => "string",
        }
        optional { error "error": bool => "boolean" }
    }
}

payload! {
    /// `ai.continue`: the answers of the tools an answer waits for.
    closed AiContinuePayload {
        required {
            id "id": String => "string",
            results "results": Vec<AiToolResult> => "readonly AiToolResult[]",
        }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `ai.poll`: what an answer gained after the length `after` already read, and its
    /// reasoning after `thinkingAfter`.
    closed AiPollPayload {
        required { id "id": String => "string" }
        optional {
            workspace "workspace": String => "string",
            after "after": u64 => "number",
            thinking_after "thinkingAfter": u64 => "number",
        }
    }
}

payload! {
    /// `ai.local.install`: downloads the engine and a model of the catalog, or the one this
    /// computer runs best.
    closed AiLocalInstallPayload {
        required {}
        optional {
            workspace "workspace": String => "string",
            model "model": String => "'qwen3.5-9b' | 'qwen3.5-4b'",
        }
    }
}

payload! {
    /// `ai.local.file`: a GGUF of the person's own, by its path on this computer.
    closed AiLocalFilePayload {
        required { path "path": String => "string" }
        optional { workspace "workspace": String => "string" }
    }
}
