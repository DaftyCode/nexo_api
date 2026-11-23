//! Payloads of the collections shared by the team (C-01). The team key is never in them:
//! the application reads it from the vault. `shared.read`, `shared.write`, `shared.stat`
//! and `shared.key.new` are the application's own calls to the engine.
use super::*;

payload! {
    /// Where the file of a shared collection is: a synced folder or a network drive.
    closed SharedLocation {
        required {
            kind "kind": String => "'folder'",
            path "path": String => "string",
        }
        optional {}
    }
}

payload! {
    /// `shared.read`: the file, opened with the team key when it is sealed.
    closed SharedReadPayload {
        required { location "location": SharedLocation => "SharedLocation" }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `shared.write`: the file, written only if it is still at version `expected`.
    closed SharedWritePayload {
        required {
            location "location": SharedLocation => "SharedLocation",
            content "content": Map<String, Value> => "Record<string, unknown>",
        }
        optional {
            workspace "workspace": String => "string",
            expected "expected": String => "string",
        }
    }
}

payload! {
    /// `shared.stat`: the size and time of change of files, read on this computer only.
    closed SharedStatPayload {
        required { paths "paths": Vec<String> => "readonly string[]" }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `shared.share`: writes a collection, and the environments chosen, to a new file that
    /// the team will keep in sync; sealed with a new team key when `encrypt` is not `false`.
    closed SharedSharePayload {
        required {
            workspace "workspace": String => "string",
            collection "collection": String => "string",
            path "path": String => "string",
        }
        optional {
            encrypt "encrypt": bool => "boolean",
            environments "environments": Vec<String> => "readonly string[]",
        }
    }
}

payload! {
    /// `shared.link`: brings a shared collection into the workspace, opened with the team
    /// `key` pasted when it is sealed.
    closed SharedLinkPayload {
        required {
            workspace "workspace": String => "string",
            path "path": String => "string",
        }
        optional { key "key": String => "string" }
    }
}

payload! {
    /// `shared.sync`, `shared.unlink` and `shared.key`: a shared collection of a workspace.
    closed SharedCollectionPayload {
        required {
            workspace "workspace": String => "string",
            collection "collection": String => "string",
        }
        optional {}
    }
}

payload! {
    /// `shared.resolve`: keeps one side of an element both people changed.
    closed SharedResolvePayload {
        required {
            workspace "workspace": String => "string",
            collection "collection": String => "string",
            id "id": String => "string",
            keep "keep": String => "'mine' | 'theirs'",
        }
        optional {}
    }
}
