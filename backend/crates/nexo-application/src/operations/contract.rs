//! The TypeScript contract of the operations.
use super::{GitOperation, Operation};

/// The TypeScript contract written to `src/app/application/operations.ts`.
pub fn typescript_contract() -> String {
    fn list(name: &str, items: Vec<&str>) -> String {
        let quoted: Vec<String> = items.iter().map(|item| format!("'{item}'")).collect();
        let single = format!("export const {name} = [{}] as const;", quoted.join(", "));
        if single.len() <= 100 {
            format!("{single}\n")
        } else {
            let lines: String = quoted.iter().map(|item| format!("  {item},\n")).collect();
            format!("export const {name} = [\n{lines}] as const;\n")
        }
    }
    format!(
        "// Generated from backend/crates/nexo-application/src/operations.rs.\n\
         // Regenerate with `NEXO_UPDATE_CONTRACTS=1 cargo test -p nexo-application`.\n\
         {}export type ExecutionOperation = (typeof EXECUTION_OPERATIONS)[number];\n\
         {}export type GitOperation = (typeof GIT_OPERATIONS)[number];\n",
        list(
            "EXECUTION_OPERATIONS",
            Operation::ALL.iter().map(|o| o.as_str()).collect()
        ),
        list(
            "GIT_OPERATIONS",
            GitOperation::ALL.iter().map(|o| o.as_str()).collect()
        ),
    )
}
