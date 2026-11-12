//! Remote URLs and their hosts, checked before Git connects.
use super::super::*;
use super::*;

#[test]
fn remote_urls_are_https_ssh_or_scp_like() {
    let ok = |url: &str| remote_url(url, false).unwrap().unwrap();
    assert_eq!(
        ok("https://github.com/acme/api.git"),
        Destination {
            host: "github.com".into(),
            port: 443
        }
    );
    assert_eq!(ok("https://user@git.example.com:8443/x.git").port, 8443);
    assert_eq!(
        ok("ssh://git@[::1]:2222/x.git"),
        Destination {
            host: "::1".into(),
            port: 2222
        }
    );
    assert_eq!(
        ok("git@GitHub.com:acme/api.git"),
        Destination {
            host: "github.com".into(),
            port: 22
        }
    );
    for url in [
        "",
        "ext::sh -c touch% /tmp/pwned",
        "ext::sh",
        "fd::17",
        "--upload-pack=touch /tmp/pwned",
        "-oProxyCommand=calc",
        "git@-oProxyCommand=calc:x",
        "file:///etc/passwd",
        "http://example.com/x.git",
        "git://example.com/x.git",
        "/home/me/repo",
        "C:\\repos\\api",
        "C:/repos/api",
        "../repo",
        "example.com:acme/api.git",
        "git@example.com:",
        "https://user:secret@example.com/x.git",
        "https://example.com/a b.git",
        "https://example.com/x\n.git",
    ] {
        assert!(remote_url(url, false).is_err(), "{url}");
    }
    assert!(
        message_of(remote_url("https://u:p@example.com/x", false).map(|_| json!(null)))
            .contains("password")
    );
    assert_eq!(remote_url("file:///tmp/repo.git", true).unwrap(), None);
}

#[tokio::test]
async fn remotes_are_checked_before_git_connects() {
    if !git_available().await {
        return;
    }
    let root = temporary();
    let policy = Arc::new(Policy::default());
    let adapter = GitAdapter::new(root.clone(), policy.clone());
    let w = workspace("w1");
    adapter
        .execute(&w, GitOperation::Init, json!({}))
        .await
        .unwrap();
    for url in ["ext::sh -c id", "--upload-pack=id", "file:///tmp/x"] {
        assert!(
            adapter
                .execute(&w, GitOperation::RemoteAdd, json!({"url": url}))
                .await
                .is_err(),
            "{url}"
        );
    }
    for remote in ["-x", "a b", "a..b"] {
        assert!(
            message_of(
                adapter
                    .execute(
                        &w,
                        GitOperation::RemoteAdd,
                        json!({"remote": remote, "url": "https://example.com/x.git"})
                    )
                    .await
            )
            .contains("remote name")
        );
    }
    adapter
        .execute(
            &w,
            GitOperation::RemoteAdd,
            json!({"remote": "origin", "url": "https://blocked.test/x.git"}),
        )
        .await
        .unwrap();
    let listed = adapter
        .execute(&w, GitOperation::RemoteList, json!({}))
        .await
        .unwrap();
    assert_eq!(
        listed["remotes"],
        json!([{"name": "origin", "url": "https://blocked.test/x.git"}])
    );
    // The egress policy refuses it before Git runs.
    for operation in [GitOperation::Fetch, GitOperation::Push] {
        assert!(
            message_of(adapter.execute(&w, operation, json!({})).await).contains("egress policy")
        );
    }
    assert_eq!(
        policy.checked.lock().unwrap()[0],
        ("blocked.test".to_string(), 443)
    );
    assert!(
        message_of(
            adapter
                .execute(&w, GitOperation::Fetch, json!({"remote": "upstream"}))
                .await
        )
        .contains("no remote named upstream")
    );
    adapter
        .execute(&w, GitOperation::RemoteRemove, json!({"remote": "origin"}))
        .await
        .unwrap();
    let listed = adapter
        .execute(&w, GitOperation::RemoteList, json!({}))
        .await
        .unwrap();
    assert_eq!(listed["remotes"], json!([]));
    // A workspace with a project is not cloned over.
    assert!(
        message_of(
            adapter
                .execute(
                    &w,
                    GitOperation::Clone,
                    json!({"url": "https://example.com/x.git"})
                )
                .await
        )
        .contains("new workspace")
    );
    assert!(
        adapter
            .execute(
                &workspace("w2"),
                GitOperation::Clone,
                json!({"url": "https://blocked.test/x.git"})
            )
            .await
            .is_err()
    );
    let _ = std::fs::remove_dir_all(root);
}
