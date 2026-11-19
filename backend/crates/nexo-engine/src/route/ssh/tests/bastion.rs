//! A bastion for the tests: an SSH server (russh's own) that signs in `ana` with the password
//! `pw` or the test keys, and relays every direct-tcpip channel to one upstream server,
//! recording the destination asked for. The keys exist for these tests only.
use russh::{
    Channel,
    keys::{PublicKey, decode_secret_key},
    server::{self, Auth, ChannelOpenHandle, Msg, Session, VerifiedPublicKey},
};
use std::{
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::net::{TcpListener, TcpStream};

pub const HOST_KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACDd2sWGzH2JhMFkrMfln6YNnAjF5LHyKBqI4KbrhTS8hwAAAJhRfcDDUX3A
wwAAAAtzc2gtZWQyNTUxOQAAACDd2sWGzH2JhMFkrMfln6YNnAjF5LHyKBqI4KbrhTS8hw
AAAEBDUYMif1ikFbn9N+nTDM2E8/zNPbF00m1sd44diYW1q93axYbMfYmEwWSsx+Wfpg2c
CMXksfIoGojgpuuFNLyHAAAADm5leG8tdGVzdC1ob3N0AQIDBAUGBw==
-----END OPENSSH PRIVATE KEY-----";
pub const HOST_PUBLIC: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIN3axYbMfYmEwWSsx+Wfpg2cCMXksfIoGojgpuuFNLyH";
pub const OTHER_KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACBmBDHwFb/wpHlNYKNGSxZjwqeWNQaapGt3MLNV7xgmQwAAAJjg2xGe4NsR
ngAAAAtzc2gtZWQyNTUxOQAAACBmBDHwFb/wpHlNYKNGSxZjwqeWNQaapGt3MLNV7xgmQw
AAAECGoFziwSY2SNP/Pf6jUQh3fr9aWdnO0LEFmc77foyYHWYEMfAVv/CkeU1go0ZLFmPC
p5Y1Bpqka3cws1XvGCZDAAAAD25leG8tdGVzdC1vdGhlcgECAwQFBg==
-----END OPENSSH PRIVATE KEY-----";
pub const CLIENT_KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACAXplFW29vKQAjGGXCG3y3A7IzQ7u2dig3r9nJgCGN+dgAAAJiHSHyUh0h8
lAAAAAtzc2gtZWQyNTUxOQAAACAXplFW29vKQAjGGXCG3y3A7IzQ7u2dig3r9nJgCGN+dg
AAAECkyMEVMYkyvRQgiLGmyi88dqKF3xyEUakfKVzwXRrbKRemUVbb28pACMYZcIbfLcDs
jNDu7Z2KDev2cmAIY352AAAAEG5leG8tdGVzdC1jbGllbnQBAgMEBQ==
-----END OPENSSH PRIVATE KEY-----";
const CLIENT_PUBLIC: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBemUVbb28pACMYZcIbfLcDsjNDu7Z2KDev2cmAIY352";
/// The same kind of key, kept with the passphrase `secreto`.
pub const LOCKED_KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABCd+eRVsa
YAli55+4su7VotAAAAGAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIKxHaYrRTddztL+w
C9Y+LfSukkCBXQ/Nme/2AqrcUlLQAAAAoEm7gDNpWb2aq/fcJYGah5Tzom5c0y1XqenL2e
80edvXy5RWnUEvcSzvc4lcA5zqy9twZTfGXnNBi/M/zlTxgcgjO/fjMFPwHF7X/wxEm56Z
ymXLsQ5jXbsqC2giFqTGOi1KgYFvxw7JJzc72NOGQCSVC8XQFEi5p0hZBtLTsgNStuIyAx
Qxc28EaR2cP9l7oERgQZeaqFcQkk83YRyMy0k=
-----END OPENSSH PRIVATE KEY-----";
const LOCKED_PUBLIC: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKxHaYrRTddztL+wC9Y+LfSukkCBXQ/Nme/2AqrcUlLQ";

/// The destinations the bastion was asked for.
pub type Asked = Arc<Mutex<Vec<String>>>;

#[derive(Clone)]
struct Bastion {
    upstream: SocketAddr,
    keys: Vec<PublicKey>,
    asked: Asked,
}

impl server::Handler for Bastion {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(if user == "ana" && password == "pw" {
            Auth::Accept
        } else {
            Auth::reject()
        })
    }

    async fn auth_publickey(
        &mut self,
        user: &str,
        key: VerifiedPublicKey<'_>,
    ) -> Result<Auth, Self::Error> {
        Ok(if user == "ana" && self.keys.contains(key.public_key) {
            Auth::Accept
        } else {
            Auth::reject()
        })
    }

    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        host: &str,
        port: u32,
        _originator: &str,
        _originator_port: u32,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.asked.lock().unwrap().push(format!("{host}:{port}"));
        reply.accept().await;
        let upstream = self.upstream;
        tokio::spawn(async move {
            let mut stream = channel.into_stream();
            if let Ok(mut tcp) = TcpStream::connect(upstream).await {
                let _ = tokio::io::copy_bidirectional(&mut stream, &mut tcp).await;
            }
        });
        Ok(())
    }
}

/// Starts a bastion with `host_key` that relays to `upstream`; returns its port.
pub async fn start(host_key: &str, upstream: SocketAddr) -> (u16, Asked) {
    let config = Arc::new(server::Config {
        keys: vec![decode_secret_key(host_key, None).unwrap()],
        auth_rejection_time: Duration::from_millis(5),
        ..Default::default()
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let asked = Asked::default();
    let bastion = Bastion {
        upstream,
        keys: [CLIENT_PUBLIC, LOCKED_PUBLIC]
            .map(|key| PublicKey::from_openssh(key).unwrap())
            .to_vec(),
        asked: asked.clone(),
    };
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let (config, bastion) = (config.clone(), bastion.clone());
            tokio::spawn(async move {
                if let Ok(session) = server::run_stream(config, socket, bastion).await {
                    let _ = session.await;
                }
            });
        }
    });
    (port, asked)
}
