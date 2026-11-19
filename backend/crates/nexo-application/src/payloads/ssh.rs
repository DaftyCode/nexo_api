//! Payloads of SSH profiles: testing one and trusting the key its server showed.
use super::*;

payload! {
    /// `ssh.test`: signs in to the server of an SSH profile once and shows its key, trusted or
    /// not yet.
    closed SshTestPayload {
        required { profile "profile": String => "string" }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `ssh.trust`: trusts the key an SSH server showed when its profile was last tested.
    closed SshTrustPayload {
        required {
            host "host": String => "string",
            port "port": u16 => "number",
            fingerprint "fingerprint": String => "string",
        }
        optional { workspace "workspace": String => "string" }
    }
}
