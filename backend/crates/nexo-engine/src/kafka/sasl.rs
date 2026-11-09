//! SASL for Kafka: PLAIN (RFC 4616) and SCRAM-SHA-256/512 (RFC 5802, RFC 7677), with
//! aws-lc-rs for PBKDF2, HMAC and SHA-2.
use aws_lc_rs::{digest, hmac, pbkdf2};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use nexo_domain::{Error, Result};
use std::num::NonZeroU32;

/// The most PBKDF2 iterations a server may ask for: enough for any real one, bounded so a
/// server cannot keep the engine busy.
const MAX_ITERATIONS: u32 = 1_000_000;

fn invalid(message: impl Into<String>) -> Error {
    Error::Validation(message.into())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mechanism {
    Plain,
    ScramSha256,
    ScramSha512,
}
impl Mechanism {
    /// The mechanism as Kafka names it; `none` (or empty) means no authentication.
    pub fn from_name(name: &str) -> Result<Option<Self>> {
        match name.trim().to_ascii_uppercase().as_str() {
            "" | "NONE" => Ok(None),
            "PLAIN" => Ok(Some(Self::Plain)),
            "SCRAM-SHA-256" => Ok(Some(Self::ScramSha256)),
            "SCRAM-SHA-512" => Ok(Some(Self::ScramSha512)),
            other => Err(invalid(format!("Unsupported SASL mechanism {other}"))),
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Plain => "PLAIN",
            Self::ScramSha256 => "SCRAM-SHA-256",
            Self::ScramSha512 => "SCRAM-SHA-512",
        }
    }
    fn algorithms(
        self,
    ) -> (
        pbkdf2::Algorithm,
        hmac::Algorithm,
        &'static digest::Algorithm,
    ) {
        match self {
            Self::ScramSha512 => (
                pbkdf2::PBKDF2_HMAC_SHA512,
                hmac::HMAC_SHA512,
                &digest::SHA512,
            ),
            _ => (
                pbkdf2::PBKDF2_HMAC_SHA256,
                hmac::HMAC_SHA256,
                &digest::SHA256,
            ),
        }
    }
    fn length(self) -> usize {
        match self {
            Self::ScramSha512 => 64,
            _ => 32,
        }
    }
}

/// The PLAIN message: no authorization identity, then the user and the password.
pub fn plain(username: &str, password: &str) -> Vec<u8> {
    format!("\0{username}\0{password}").into_bytes()
}

/// A random client nonce of printable characters.
pub fn nonce() -> String {
    let mut bytes = [0u8; 24];
    let _ = aws_lc_rs::rand::fill(&mut bytes);
    STANDARD.encode(bytes)
}

/// A SCRAM exchange from the client side.
pub struct Scram {
    mechanism: Mechanism,
    password: String,
    nonce: String,
    client_first_bare: String,
    /// What the server must prove once the client has sent its proof.
    server_signature: Option<Vec<u8>>,
}
impl Scram {
    pub fn new(mechanism: Mechanism, username: &str, password: &str, nonce: String) -> Self {
        // `=` and `,` are escaped in the user name (RFC 5802, `saslname`).
        let user = username.replace('=', "=3D").replace(',', "=2C");
        Self {
            mechanism,
            password: password.to_string(),
            client_first_bare: format!("n={user},r={nonce}"),
            nonce,
            server_signature: None,
        }
    }
    /// `client-first-message`: no channel binding.
    pub fn client_first(&self) -> String {
        format!("n,,{}", self.client_first_bare)
    }
    /// `client-final-message` with the proof, from the server's first message.
    pub fn client_final(&mut self, server_first: &str) -> Result<String> {
        let field = |name: &str| {
            server_first
                .split(',')
                .find_map(|part| part.strip_prefix(&format!("{name}=")))
                .ok_or_else(|| invalid("The broker answered SCRAM incompletely"))
        };
        if let Ok(error) = field("e") {
            return Err(invalid(format!("SCRAM authentication failed: {error}")));
        }
        let nonce = field("r")?;
        if !nonce.starts_with(&self.nonce) || nonce.len() == self.nonce.len() {
            return Err(invalid("The broker answered SCRAM with a wrong nonce"));
        }
        let salt = STANDARD
            .decode(field("s")?)
            .map_err(|_| invalid("The broker sent an invalid SCRAM salt"))?;
        let iterations = field("i")?
            .parse::<u32>()
            .ok()
            .filter(|iterations| (1..=MAX_ITERATIONS).contains(iterations))
            .and_then(NonZeroU32::new)
            .ok_or_else(|| invalid("The broker sent an invalid SCRAM iteration count"))?;
        let (derivation, mac, hash) = self.mechanism.algorithms();
        let mut salted = vec![0u8; self.mechanism.length()];
        pbkdf2::derive(
            derivation,
            iterations,
            &salt,
            self.password.as_bytes(),
            &mut salted,
        );
        let salted = hmac::Key::new(mac, &salted);
        let client_key = hmac::sign(&salted, b"Client Key");
        let stored_key = digest::digest(hash, client_key.as_ref());
        let without_proof = format!("c=biws,r={nonce}");
        let auth_message = format!("{},{server_first},{without_proof}", self.client_first_bare);
        let signature = hmac::sign(
            &hmac::Key::new(mac, stored_key.as_ref()),
            auth_message.as_bytes(),
        );
        let proof: Vec<u8> = client_key
            .as_ref()
            .iter()
            .zip(signature.as_ref())
            .map(|(key, signature)| key ^ signature)
            .collect();
        let server_key = hmac::sign(&salted, b"Server Key");
        self.server_signature = Some(
            hmac::sign(
                &hmac::Key::new(mac, server_key.as_ref()),
                auth_message.as_bytes(),
            )
            .as_ref()
            .to_vec(),
        );
        Ok(format!("{without_proof},p={}", STANDARD.encode(proof)))
    }
    /// What a server answers in its final message, for test brokers.
    #[cfg(test)]
    pub(crate) fn server_final(&self) -> Option<String> {
        self.server_signature
            .as_ref()
            .map(|signature| format!("v={}", STANDARD.encode(signature)))
    }
    /// Checks the server's final message: it proves the server knows the password too.
    pub fn verify(&self, server_final: &str) -> Result<()> {
        if let Some(error) = server_final.strip_prefix("e=") {
            return Err(invalid(format!("SCRAM authentication failed: {error}")));
        }
        let expected = self
            .server_signature
            .as_ref()
            .ok_or_else(|| invalid("SCRAM ended before the client proof"))?;
        let signature = server_final
            .strip_prefix("v=")
            .and_then(|value| STANDARD.decode(value).ok())
            .ok_or_else(|| invalid("The broker answered SCRAM incompletely"))?;
        if aws_lc_rs::constant_time::verify_slices_are_equal(&signature, expected).is_err() {
            return Err(invalid("The broker could not prove it knows the password"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 7677, section 3.
    #[test]
    fn scram_sha_256_matches_the_rfc_example() {
        let mut scram = Scram::new(
            Mechanism::ScramSha256,
            "user",
            "pencil",
            "rOprNGfwEbeRWgbNEkqO".into(),
        );
        assert_eq!(scram.client_first(), "n,,n=user,r=rOprNGfwEbeRWgbNEkqO");
        let server_first = "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096";
        assert_eq!(
            scram.client_final(server_first).unwrap(),
            "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ="
        );
        scram
            .verify("v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=")
            .unwrap();
        assert!(scram.verify("v=AAAA").is_err());
        assert!(
            scram
                .verify("e=invalid-proof")
                .unwrap_err()
                .to_string()
                .contains("invalid-proof")
        );
    }

    #[test]
    fn scram_refuses_wrong_or_hostile_answers() {
        let fresh = || Scram::new(Mechanism::ScramSha512, "a=b,c", "p", "abc".into());
        assert_eq!(fresh().client_first(), "n,,n=a=3Db=2Cc,r=abc");
        for answer in [
            "r=xyz123,s=AAAA,i=4096",
            "r=abc,s=AAAA,i=4096",
            "r=abcdef,s=%%,i=4096",
            "r=abcdef,s=AAAA,i=0",
            "r=abcdef,s=AAAA,i=99999999",
            "r=abcdef,s=AAAA",
            "e=unknown-user",
        ] {
            assert!(fresh().client_final(answer).is_err(), "{answer}");
        }
        let mut scram = fresh();
        let last = scram.client_final("r=abcdef,s=AAAA,i=4096").unwrap();
        assert!(last.starts_with("c=biws,r=abcdef,p="));
        // SHA-512 proofs are 64 bytes.
        assert_eq!(
            STANDARD
                .decode(last.split(",p=").nth(1).unwrap())
                .unwrap()
                .len(),
            64
        );
        assert!(
            Scram::new(Mechanism::ScramSha256, "u", "p", "n".into())
                .verify("v=AAAA")
                .is_err()
        );
    }

    #[test]
    fn mechanisms_and_plain_messages() {
        assert_eq!(
            Mechanism::from_name(" scram-sha-512 ").unwrap(),
            Some(Mechanism::ScramSha512)
        );
        assert_eq!(Mechanism::from_name("none").unwrap(), None);
        assert_eq!(Mechanism::from_name("").unwrap(), None);
        assert!(Mechanism::from_name("GSSAPI").is_err());
        assert_eq!(Mechanism::Plain.name(), "PLAIN");
        assert_eq!(plain("alice", "secret"), b"\0alice\0secret");
        assert_ne!(nonce(), nonce());
    }
}
