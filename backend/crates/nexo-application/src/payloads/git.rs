//! Payloads of the Git operations on the workspace project.
use super::*;

payload! {
    /// A collection written to the workspace project by Git `export`.
    closed GitFile {
        required {
            id "id": String => "string",
            value "value": Value => "unknown",
        }
        optional {}
    }
}

payload! {
    /// Git operations on the workspace project.
    closed GitPayload {
        required {}
        optional {
            workspace "workspace": String => "string",
            branch "branch": String => "string",
            message "message": String => "string",
            files "files": Vec<GitFile> => "readonly GitFile[]",
            remote "remote": String => "string",
            url "url": String => "string",
            rebase "rebase": bool => "boolean",
            force_with_lease "forceWithLease": bool => "boolean",
        }
    }
}
