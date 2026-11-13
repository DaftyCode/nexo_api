//! Payloads of the database modules.
use super::*;

payload! {
    /// `modules.install`, `modules.progress`, `modules.remove`: a module, by its id.
    closed ModulePayload {
        required { id "id": String => "string" }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `modules.install.file`: a module file the person chose, in base64.
    closed ModuleFilePayload {
        required { content "content": String => "string" }
        optional { workspace "workspace": String => "string" }
    }
}
