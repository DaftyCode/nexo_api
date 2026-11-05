//! Operations clients may run, as types. Adding one makes every exhaustive `match` (the
//! engine dispatch) fail to compile until it is handled, and the TypeScript contract test
//! fails until `src/app/application/operations.ts` is regenerated.
use nexo_domain::{Error, Result};

macro_rules! operations {
    ($(#[$meta:meta])* $name:ident, $error:literal, { $($variant:ident => $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum $name {
            $($variant),+
        }
        impl $name {
            pub const ALL: &'static [$name] = &[$(Self::$variant),+];
            pub fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $text),+
                }
            }
            pub fn parse(text: &str) -> Result<Self> {
                match text {
                    $($text => Ok(Self::$variant),)+
                    _ => Err(Error::Validation($error.into())),
                }
            }
        }
        impl std::fmt::Display for $name {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str(self.as_str())
            }
        }
    };
}

operations!(
    /// Execution engine operations.
    Operation, "Unknown execution operation", {
        Request => "request",
        Run => "run",
        Cancel => "cancel",
        Import => "import",
        Codegen => "codegen",
        RealtimeConnect => "realtime.connect",
        RealtimeSend => "realtime.send",
        RealtimeClose => "realtime.close",
        RealtimePoll => "realtime.poll",
        RealtimeList => "realtime.list",
        Grpc => "grpc",
        MockStart => "mock.start",
        MockStop => "mock.stop",
        MockList => "mock.list",
        DatasetQuery => "dataset.query",
        DatasetImport => "dataset.import",
        DatasetSchema => "dataset.schema",
        DatasetParse => "dataset.parse",
        DatasetDelete => "dataset.delete",
        McpRequest => "mcp.request",
        OauthToken => "oauth.token",
        Oauth2Token => "oauth2.token",
        Oauth2Authorize => "oauth2.authorize",
        Oauth2Tokens => "oauth2.tokens",
        CookiesList => "cookies.list",
        CookiesClear => "cookies.clear",
        Performance => "performance",
        PerformanceCancel => "performance.cancel",
    }
);
impl Operation {
    /// Operations whose data belongs to a workspace and need one.
    pub fn needs_workspace(self) -> bool {
        matches!(
            self,
            Self::DatasetQuery
                | Self::DatasetImport
                | Self::DatasetSchema
                | Self::DatasetDelete
                | Self::CookiesList
                | Self::CookiesClear
        )
    }
}

operations!(
    /// Local Git operations on a workspace export.
    GitOperation, "Unsupported Git operation", {
        Init => "init",
        Status => "status",
        Diff => "diff",
        Log => "log",
        Branches => "branches",
        Checkout => "checkout",
        Branch => "branch",
        Commit => "commit",
        Stash => "stash",
        Export => "export",
    }
);

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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn operations_round_trip_and_reject_unknown_names() {
        for operation in Operation::ALL {
            assert_eq!(Operation::parse(operation.as_str()).unwrap(), *operation);
        }
        for operation in GitOperation::ALL {
            assert_eq!(GitOperation::parse(operation.as_str()).unwrap(), *operation);
        }
        assert!(Operation::parse("shell.exec").is_err());
        assert!(Operation::parse("vault.get").is_err());
        assert!(GitOperation::parse("push").is_err());
    }
    #[test]
    fn typescript_contract_is_current() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../src/app/application/operations.ts");
        let expected = typescript_contract();
        if std::env::var_os("NEXO_UPDATE_CONTRACTS").is_some() {
            std::fs::write(&path, &expected).unwrap();
        }
        let current = std::fs::read_to_string(&path)
            .unwrap_or_default()
            .replace("\r\n", "\n");
        assert_eq!(
            current, expected,
            "operations.ts is out of date; run NEXO_UPDATE_CONTRACTS=1 cargo test -p nexo-application"
        );
    }
}
