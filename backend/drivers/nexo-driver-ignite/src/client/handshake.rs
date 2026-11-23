//! The handshake of the client protocol: the client proposes version 3.0.0 as a general
//! client, with no optional features (no partition awareness, no direct transactions) and,
//! when the cluster has authentication, the `basic` user and password; the node answers its
//! version, its name, the cluster's and the product version.
use super::errors;
use crate::msgpack::{Reader, Writer};
use nexo_driver_sdk::Result;

/// The version of the protocol (`ProtocolVersion.V3_0_0`).
const VERSION: [i64; 3] = [3, 0, 0];
/// A general client (`HandshakeUtils.CLIENT_TYPE_GENERAL`).
const GENERAL_CLIENT: i64 = 2;

/// What the node said about itself.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Node {
    pub name: String,
    pub cluster: String,
    /// `3.1.0`.
    pub version: String,
    /// How long the node keeps a connection that sends nothing, in milliseconds; 0 for ever.
    pub idle_ms: i64,
    pub observed: i64,
}

/// The handshake, after the magic bytes: version, client type, features, extensions.
pub fn request(user: Option<&str>, password: Option<&str>) -> Vec<u8> {
    let mut writer = Writer::default();
    for part in VERSION {
        writer.int(part);
    }
    writer.int(GENERAL_CLIENT).bin(&[]);
    match user.filter(|user| !user.is_empty()) {
        Some(user) => {
            writer
                .int(3)
                .str("authn-type")
                .str("basic")
                .str("authn-identity")
                .str(user)
                .str("authn-secret")
                .str(password.unwrap_or_default());
        }
        None => {
            writer.int(0);
        }
    }
    writer.into_bytes()
}

/// The node's answer, or the error it refused the connection with.
pub fn response(bytes: &[u8]) -> Result<Node> {
    let mut reader = Reader::new(bytes);
    for _ in VERSION {
        reader.int()?;
    }
    if !reader.nil()? {
        return Err(errors::read(&mut reader)?);
    }
    let idle_ms = reader.int()?;
    reader.uuid()?;
    let name = reader.str()?;
    let clusters = reader.int()?;
    for _ in 0..clusters {
        reader.uuid()?;
    }
    let cluster = reader.str()?;
    let observed = reader.int()?;
    let (major, minor, maintenance) = (reader.int()?, reader.int()?, reader.int()?);
    let patch = if reader.nil()? {
        None
    } else {
        Some(reader.int()?)
    };
    let pre_release = reader.opt_str()?;
    let mut version = format!("{major}.{minor}.{maintenance}");
    if let Some(patch) = patch {
        version.push_str(&format!(".{patch}"));
    }
    if let Some(pre_release) = pre_release.filter(|text| !text.is_empty()) {
        version.push_str(&format!("-{pre_release}"));
    }
    Ok(Node {
        name,
        cluster,
        version,
        idle_ms,
        observed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use nexo_driver_sdk::ErrorCode;

    fn uuid(writer: &mut Vec<u8>) {
        writer.extend([0xd8, 3]);
        writer.extend([0; 16]);
    }

    #[test]
    fn the_request_carries_the_user_only_when_there_is_one() {
        let anonymous = request(None, None);
        assert_eq!(anonymous, [3, 0, 0, 2, 0xc4, 0, 0]);
        let basic = request(Some("ignite"), Some("secret"));
        let mut reader = Reader::new(&basic);
        for _ in 0..4 {
            reader.int().unwrap();
        }
        assert_eq!(reader.bin().unwrap(), [] as [u8; 0]);
        assert_eq!(reader.int().unwrap(), 3);
        let pairs: Vec<String> = (0..6).map(|_| reader.str().unwrap()).collect();
        assert_eq!(pairs[1], "basic");
        assert_eq!(pairs[3], "ignite");
        assert_eq!(pairs[5], "secret");
        assert_eq!(request(Some(""), Some("x")), anonymous);
    }

    #[test]
    fn the_answer_says_the_node_and_its_version() {
        let mut bytes = vec![3, 0, 0, 0xc0, 0xcd, 0x75, 0x30];
        uuid(&mut bytes);
        let mut middle = Writer::default();
        middle.str("defaultNode").int(1);
        bytes.extend(middle.into_bytes());
        uuid(&mut bytes);
        let mut rest = Writer::default();
        rest.str("nexo")
            .int(42)
            .int(3)
            .int(1)
            .int(0)
            .nil()
            .nil()
            .bin(&[1])
            .int(0);
        bytes.extend(rest.into_bytes());
        let node = response(&bytes).unwrap();
        assert_eq!(node.name, "defaultNode");
        assert_eq!(node.cluster, "nexo");
        assert_eq!(node.version, "3.1.0");
        assert_eq!(node.idle_ms, 30_000);
        assert_eq!(node.observed, 42);
    }

    #[test]
    fn a_refused_handshake_says_why() {
        let mut bytes = vec![3, 0, 0];
        uuid(&mut bytes);
        let mut rest = Writer::default();
        rest.int(15 << 16 | 2)
            .str("org.apache.ignite.security.exception.InvalidCredentialsException")
            .str("IGN-AUTHENTICATION-2 TraceId:x Authentication failed")
            .nil()
            .nil();
        bytes.extend(rest.into_bytes());
        let error = response(&bytes).unwrap_err();
        assert_eq!(error.code, ErrorCode::Auth);
        assert_eq!(error.message, "Authentication failed");
    }
}
