//! Server keys: Nexo's own `known_hosts`, where the keys the person trusts are written, and
//! the user's OpenSSH one, read only. A key either file has is known; a different key of the
//! same kind for that server means it changed.
use nexo_domain::{Error, Result};
use russh::keys::{HashAlg, PublicKey, known_hosts};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Verdict {
    Known,
    Unknown,
    Changed,
}

/// The OpenSSH file of the user, when there is a home folder.
fn openssh() -> Option<PathBuf> {
    std::env::home_dir().map(|home| home.join(".ssh").join("known_hosts"))
}

pub(super) fn check(host: &str, port: u16, key: &PublicKey, nexo: Option<&Path>) -> Verdict {
    let files = nexo.map(Path::to_path_buf).into_iter().chain(openssh());
    let mut changed = false;
    for path in files.filter(|path| path.is_file()) {
        match known_hosts::check_known_hosts_path(host, port, key, &path) {
            Ok(true) => return Verdict::Known,
            Err(russh::keys::Error::KeyChanged { .. }) => changed = true,
            // Not there, or a file that cannot be read: it says nothing of this key.
            Ok(false) | Err(_) => {}
        }
    }
    if changed {
        Verdict::Changed
    } else {
        Verdict::Unknown
    }
}

/// `SHA256:…`, as `ssh-keygen -l` shows it.
pub(super) fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

/// Writes the key in Nexo's file, so the next sessions trust it.
pub(super) fn learn(path: &Path, host: &str, port: u16, key: &PublicKey) -> Result<()> {
    known_hosts::learn_known_hosts_path(host, port, key, path)
        .map_err(|error| Error::Infrastructure(format!("The key could not be kept: {error}")))
}
