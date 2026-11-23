//! Payloads of the collections shared by the team (C-01). The team key is never in them:
//! the application reads it from the vault. `shared.read`, `shared.write`, `shared.stat`
//! and `shared.key.new` are the application's own calls to the engine.
use super::*;

payload! {
    /// Where the file of a shared collection is: a synced folder or a network drive
    /// (`path`), or a server (`url`, signed in with the vault secret `auth` names).
    closed SharedLocation {
        required { kind "kind": String => "'folder' | 'url'" }
        optional {
            path "path": String => "string",
            url "url": String => "string",
            auth "auth": Map<String, Value> => "{\n    scheme: 'basic' | 'bearer';\n    user?: string;\n    secretName: string;\n  }",
        }
    }
}

payload! {
    /// How Nexo signs in to the server of a shared collection; the secret goes to the vault.
    closed SharedCredential {
        required { scheme "scheme": String => "'none' | 'basic' | 'bearer'" }
        optional {
            user "user": String => "string",
            secret "secret": String => "string",
        }
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
    /// the team will keep in sync, in a folder (`path`) or on a server (`url`); sealed with a
    /// new team key when `encrypt` is not `false`.
    closed SharedSharePayload {
        required {
            workspace "workspace": String => "string",
            collection "collection": String => "string",
        }
        optional {
            path "path": String => "string",
            url "url": String => "string",
            credential "credential": SharedCredential => "SharedCredential",
            encrypt "encrypt": bool => "boolean",
            environments "environments": Vec<String> => "readonly string[]",
        }
    }
}

payload! {
    /// `shared.link`: brings a shared collection into the workspace from a folder (`path`)
    /// or a server (`url`), opened with the team `key` pasted when it is sealed.
    closed SharedLinkPayload {
        required { workspace "workspace": String => "string" }
        optional {
            path "path": String => "string",
            url "url": String => "string",
            credential "credential": SharedCredential => "SharedCredential",
            key "key": String => "string",
        }
    }
}

payload! {
    /// `shared.poll`: the files that changed; a server is asked only when the workspace
    /// is `opening`.
    closed SharedPollPayload {
        required {}
        optional {
            workspace "workspace": String => "string",
            opening "opening": bool => "boolean",
        }
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
