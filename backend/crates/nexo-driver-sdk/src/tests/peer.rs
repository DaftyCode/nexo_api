use crate::{DriverError, ErrorCode, Handler, Peer, Result};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

/// Echoes, waits when asked to, asks back with `ask`, and keeps what it is notified of.
struct Echo {
    peer: Peer,
    notified: Arc<Mutex<Vec<Value>>>,
}
#[async_trait]
impl Handler for Echo {
    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        match method {
            "echo" => Ok(params),
            "slow" => {
                tokio::time::sleep(Duration::from_millis(200)).await;
                Ok(json!("slow"))
            }
            "never" => std::future::pending().await,
            "ask" => self.peer.request("echo", json!({"asked": params})).await,
            other => Err(DriverError::unsupported(other)),
        }
    }
    async fn notification(&self, _method: &str, params: Value) {
        self.notified.lock().unwrap().push(params);
    }
}

/// Two peers talking over pipes in memory, and what the second one was notified of.
fn pair() -> (Peer, Peer, Arc<Mutex<Vec<Value>>>) {
    let (left_out, right_in) = tokio::io::duplex(1024);
    let (right_out, left_in) = tokio::io::duplex(1024);
    let notified = Arc::new(Mutex::new(Vec::new()));
    let echo = |notified: Arc<Mutex<Vec<Value>>>| move |peer| Echo { peer, notified };
    let (left, _) = Peer::start(left_in, left_out, echo(Arc::default()));
    let (right, _) = Peer::start(right_in, right_out, echo(notified.clone()));
    (left, right, notified)
}

#[tokio::test]
async fn a_request_gets_its_answer() {
    let (left, _right, _) = pair();
    assert_eq!(
        left.request("echo", json!({"n": 1})).await,
        Ok(json!({"n": 1}))
    );
    let error = left.request("missing", json!(null)).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Unsupported);
}

#[tokio::test]
async fn answers_arrive_out_of_order_to_who_asked() {
    let (left, _right, _) = pair();
    let slow = tokio::spawn({
        let left = left.clone();
        async move { left.request("slow", json!(null)).await }
    });
    // Asked later, answered first: the slow request does not hold the others.
    for n in 0..20 {
        assert_eq!(left.request("echo", json!(n)).await, Ok(json!(n)));
    }
    assert!(!slow.is_finished());
    assert_eq!(slow.await.unwrap(), Ok(json!("slow")));
}

#[tokio::test]
async fn the_other_side_can_ask_while_it_answers() {
    let (left, _right, _) = pair();
    assert_eq!(left.request("ask", json!(5)).await, Ok(json!({"asked": 5})));
}

#[tokio::test]
async fn a_message_larger_than_the_pipe_arrives_whole() {
    let (left, _right, _) = pair();
    let large = "x".repeat(200_000);
    assert_eq!(left.request("echo", json!(large)).await, Ok(json!(large)));
}

#[tokio::test]
async fn notifications_are_not_answered() {
    let (left, _right, notified) = pair();
    left.notify("log", json!("one")).await;
    left.notify("log", json!("two")).await;
    // A request after them: when it is answered, both were read.
    left.request("echo", json!(null)).await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(*notified.lock().unwrap(), [json!("one"), json!("two")]);
}

#[tokio::test]
async fn closing_fails_what_waits_and_what_comes_after() {
    let (left, right, _) = pair();
    let waiting = tokio::spawn({
        let left = left.clone();
        async move { left.request("never", json!(null)).await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    // The other side stops writing: this side sees the end of its input.
    right.close();
    let error = waiting.await.unwrap().unwrap_err();
    assert_eq!(error.code, ErrorCode::Closed);
    assert!(left.is_closed());
    let error = left.request("echo", json!(null)).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Closed);
}

#[tokio::test]
async fn a_caller_that_gives_up_is_forgotten() {
    let (left, _right, _) = pair();
    let gave_up = tokio::time::timeout(
        Duration::from_millis(50),
        left.request("never", json!(null)),
    )
    .await;
    assert!(gave_up.is_err());
    assert_eq!(left.waiting(), 0);
    // The conversation goes on.
    assert_eq!(left.request("echo", json!(1)).await, Ok(json!(1)));
}
