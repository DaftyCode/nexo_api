//! When a driver process ends: with its input, with the host, and when nobody uses it.
mod common;

use common::{connection, eventually, fixture, fixture_with, statement};
use nexo_driver_sdk::{ErrorCode, Value, methods, statements::ExecuteResult};
use nexo_modules::DriverHost;
use std::{process::Stdio, time::Duration};

/// Whether a process of the system is still running.
fn alive(pid: u32) -> bool {
    let pid = pid.to_string();
    if cfg!(windows) {
        let filter = format!("PID eq {pid}");
        let listed = std::process::Command::new("tasklist")
            .args(["/FI", &filter, "/NH", "/FO", "CSV"])
            .output()
            .expect("tasklist runs");
        String::from_utf8_lossy(&listed.stdout).contains(&format!("\"{pid}\""))
    } else {
        let signalled = std::process::Command::new("kill")
            .args(["-0", &pid])
            .stderr(Stdio::null())
            .status()
            .expect("kill runs");
        signalled.success()
    }
}

async fn pid(host: &DriverHost, connection: &str) -> u32 {
    let answer: ExecuteResult = host
        .call(
            connection,
            methods::EXECUTE,
            &statement(connection, "pid", "select pid"),
        )
        .await
        .unwrap();
    match answer.rows[0][0] {
        Value::Integer(pid) => pid as u32,
        ref other => panic!("not a process: {other:?}"),
    }
}

#[tokio::test]
async fn a_driver_ends_when_its_input_does() {
    // As when Nexo dies without closing anything: the pipe closes and the driver leaves.
    let executable =
        common::modules_dir().join(format!("nexo-driver-test{}", std::env::consts::EXE_SUFFIX));
    let mut child = tokio::process::Command::new(executable)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    drop(child.stdin.take());
    let status = tokio::time::timeout(Duration::from_secs(10), child.wait()).await;
    assert!(status.expect("the driver ended").unwrap().success());
}

#[tokio::test]
async fn shutting_the_host_down_leaves_no_driver_running() {
    let fixture = fixture();
    fixture
        .host
        .connect("test", connection("main"), Vec::new())
        .await
        .unwrap();
    let driver = pid(&fixture.host, "main").await;
    assert!(alive(driver));
    fixture.host.shutdown().await;
    assert!(!alive(driver));
    assert!(fixture.host.running().await.is_empty());
}

#[tokio::test]
async fn dropping_the_host_kills_a_driver_that_is_busy() {
    let fixture = fixture();
    fixture
        .host
        .connect("test", connection("main"), Vec::new())
        .await
        .unwrap();
    let driver = pid(&fixture.host, "main").await;
    let busy = tokio::spawn({
        let host = fixture.host.clone();
        async move {
            let slow = statement("main", "slow", "sleep 60000");
            let _ = host
                .call::<_, ExecuteResult>("main", methods::EXECUTE, &slow)
                .await;
        }
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    busy.abort();
    let _ = busy.await;
    drop(fixture);
    eventually("the driver is gone", async || !alive(driver)).await;
}

#[tokio::test]
async fn closes_idle_connections_and_then_their_driver() {
    let fixture = fixture_with(|config| config.idle = Duration::from_millis(400));
    let host = &fixture.host;
    host.connect("test", connection("used"), Vec::new())
        .await
        .unwrap();
    host.connect("test", connection("forgotten"), Vec::new())
        .await
        .unwrap();
    let driver = pid(host, "used").await;
    // One connection keeps being used: it and the driver stay, the other one is closed.
    for _ in 0..8 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        pid(host, "used").await;
    }
    let forgotten = host
        .call::<_, ExecuteResult>(
            "forgotten",
            methods::EXECUTE,
            &statement("forgotten", "s", "count people"),
        )
        .await;
    assert_eq!(forgotten.unwrap_err().code, ErrorCode::Invalid);
    assert_eq!(host.running().await, ["test"]);
    // Nobody uses anything: the last connection is closed, and then the driver.
    eventually("the driver stopped", async || {
        host.running().await.is_empty()
    })
    .await;
    eventually("the process is gone", async || !alive(driver)).await;
    // And it comes back when it is needed.
    host.connect("test", connection("used"), Vec::new())
        .await
        .unwrap();
    assert_ne!(pid(host, "used").await, driver);
    host.shutdown().await;
}

#[tokio::test]
async fn runs_no_more_drivers_than_allowed() {
    // One process at most, and it is the test driver's: another module has no room while
    // that one has a connection, and gets it when it has none.
    let fixture = fixture_with(|config| config.max_processes = 1);
    let host = &fixture.host;
    host.connect("test", connection("main"), Vec::new())
        .await
        .unwrap();
    let copy =
        common::modules_dir().join(format!("nexo-driver-other{}", std::env::consts::EXE_SUFFIX));
    let original =
        common::modules_dir().join(format!("nexo-driver-test{}", std::env::consts::EXE_SUFFIX));
    std::fs::copy(original, &copy).unwrap();
    let full = host.hello("other").await.unwrap_err();
    assert_eq!(full.code, ErrorCode::Invalid);
    assert!(full.message.contains("Too many"), "{}", full.message);
    host.disconnect("main").await.unwrap();
    // There is room now, but the copy says it is the `test` driver: not the module asked for.
    let mismatch = host.hello("other").await.unwrap_err();
    assert_eq!(mismatch.code, ErrorCode::Unsupported);
    assert!(host.running().await.is_empty());
    let _ = std::fs::remove_file(copy);
}
