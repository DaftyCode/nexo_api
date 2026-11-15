//! Named instances (`server\instance`): the SQL Server Browser on UDP 1434 says which TCP
//! port each one listens on. Its address comes from the host, as every other one.
use nexo_driver_sdk::{DriverError, HostLink, Result};
use std::time::Duration;
use tokio::net::UdpSocket;

const PORT: u16 = 1434;
/// `CLNT_UCAST_INST`: asks one server for one instance.
const ASK: u8 = 0x04;
const WAIT: Duration = Duration::from_secs(3);

/// The TCP port of an instance in the Browser's answer
/// (`ServerName;S;InstanceName;I;IsClustered;No;Version;16.0;tcp;1433;;`).
pub(crate) fn port_in(answer: &[u8], instance: &str) -> Option<u16> {
    let text = String::from_utf8_lossy(answer.get(3..)?);
    for record in text.split(";;") {
        let fields: Vec<&str> = record.split(';').collect();
        let named = fields.chunks(2).any(|pair| {
            pair.len() == 2
                && pair[0].eq_ignore_ascii_case("InstanceName")
                && pair[1].eq_ignore_ascii_case(instance)
        });
        if !named {
            continue;
        }
        let port = fields
            .chunks(2)
            .find(|pair| pair.len() == 2 && pair[0].eq_ignore_ascii_case("tcp"))?;
        return port[1].parse().ok();
    }
    None
}

/// Asks the Browser of `host` for the port of `instance`.
pub(crate) async fn port(
    link: &HostLink,
    connection: &str,
    host: &str,
    instance: &str,
) -> Result<u16> {
    let addresses = link.resolve(connection, host, PORT).await?;
    let mut question = vec![ASK];
    question.extend_from_slice(instance.as_bytes());
    question.push(0);
    for address in addresses {
        let local = if address.is_ipv4() {
            "0.0.0.0:0"
        } else {
            "[::]:0"
        };
        let Ok(socket) = UdpSocket::bind(local).await else {
            continue;
        };
        if socket.send_to(&question, address).await.is_err() {
            continue;
        }
        let mut answer = vec![0; 4096];
        if let Ok(Ok(read)) = tokio::time::timeout(WAIT, socket.recv(&mut answer)).await
            && let Some(port) = port_in(&answer[..read], instance)
        {
            return Ok(port);
        }
    }
    Err(DriverError::network(format!(
        "The SQL Server Browser of {host} did not say where the instance {instance} is: \
         is the Browser running, or give the instance's port instead"
    )))
}

#[cfg(test)]
mod tests {
    use super::port_in;

    #[test]
    fn reads_the_port_of_the_instance() {
        let body = "ServerName;HOST;InstanceName;SQLEXPRESS;IsClustered;No;Version;16.0.1000.6;tcp;49172;;\
            ServerName;HOST;InstanceName;OTHER;IsClustered;No;Version;16.0;tcp;50000;;";
        let mut answer = vec![0x05, body.len() as u8, 0];
        answer.extend_from_slice(body.as_bytes());
        assert_eq!(port_in(&answer, "sqlexpress"), Some(49172));
        assert_eq!(port_in(&answer, "OTHER"), Some(50000));
        assert_eq!(port_in(&answer, "missing"), None);
    }
}
