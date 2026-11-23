//! The TypeScript side of the payloads, generated from the same declarations.
use super::*;

/// The TypeScript contract written to `src/app/application/payloads.ts`.
pub fn typescript_contract() -> String {
    let mut parts = vec![
        "// Generated from backend/crates/nexo-application/src/payloads.rs.\n\
         // Regenerate with `NEXO_UPDATE_CONTRACTS=1 cargo test -p nexo-application`.\n\
         import type { ExecutionOperation } from './operations';\n"
            .to_string(),
        VariableRow::TYPESCRIPT.to_string(),
        ExecutionContext::TYPESCRIPT.to_string(),
        RunCursor::TYPESCRIPT.to_string(),
        FileAttachment::TYPESCRIPT.to_string(),
        CookieKey::TYPESCRIPT.to_string(),
        GitFile::TYPESCRIPT.to_string(),
        MongoConnection::TYPESCRIPT.to_string(),
        MongoCollectionRef::TYPESCRIPT.to_string(),
        ComparedHeader::TYPESCRIPT.to_string(),
        ComparedResponse::TYPESCRIPT.to_string(),
        CompareSide::TYPESCRIPT.to_string(),
        CompareTable::TYPESCRIPT.to_string(),
        AiMessage::TYPESCRIPT.to_string(),
    ];
    parts.extend(typescript_interfaces().into_iter().map(String::from));
    parts.push(GitPayload::TYPESCRIPT.to_string());
    parts.push(typescript_map());
    parts.push(
        "/** The payload of an operation. */\n\
         export type PayloadOf<O extends ExecutionOperation> = OperationPayloads[O];\n"
            .to_string(),
    );
    parts.join("\n")
}
