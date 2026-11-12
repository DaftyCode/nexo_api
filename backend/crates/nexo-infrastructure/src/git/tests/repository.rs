//! Working with a real repository: isolation from parent repositories and a bare remote.
use super::super::*;
use super::*;

#[tokio::test]
async fn operations_never_reach_a_parent_repository() {
    if !git_available().await {
        return;
    }
    let parent = temporary();
    plain_git(&parent, &["init", "-q"]);
    std::fs::write(parent.join("work.txt"), "uncommitted").unwrap();
    let adapter = GitAdapter::new(
        parent.join(".nexo").join("projects"),
        Arc::new(Policy::default()),
    );
    let local = workspace("local");
    for operation in [
        GitOperation::Status,
        GitOperation::Stash,
        GitOperation::Commit,
        GitOperation::Log,
        GitOperation::Fetch,
        GitOperation::Push,
        GitOperation::RemoteList,
    ] {
        let result = adapter.execute(&local, operation, json!({})).await;
        assert!(
            message_of(result).contains("Initialize"),
            "{operation} must require init"
        );
    }
    assert_eq!(
        std::fs::read_to_string(parent.join("work.txt")).unwrap(),
        "uncommitted"
    );
    let initialized = adapter
        .execute(&local, GitOperation::Init, json!({}))
        .await
        .unwrap();
    assert_eq!(initialized["success"], true);
    let status = adapter
        .execute(&local, GitOperation::Status, json!({}))
        .await
        .unwrap();
    assert!(!status["stdout"].as_str().unwrap().contains("work.txt"));
    let _ = std::fs::remove_dir_all(parent);
}

#[tokio::test]
async fn clone_push_fetch_and_pull_with_a_bare_remote() {
    if !git_available().await {
        return;
    }
    let root = temporary();
    let bare = root.join("remote.git");
    std::fs::create_dir_all(&bare).unwrap();
    plain_git(&bare, &["init", "-q", "--bare", "--initial-branch=main"]);
    let url = file_url(&bare);
    let adapter =
        GitAdapter::new(root.join("projects"), Arc::new(Policy::default())).with_local_remotes();
    let (first, second) = (workspace("first"), workspace("second"));
    let run = |w: &WorkspaceId, operation: GitOperation, payload: Value| {
        let (adapter, w) = (&adapter, w.clone());
        async move { adapter.execute(&w, operation, payload).await }
    };
    let export = |w: &WorkspaceId, value: Value| {
        run(
            w,
            GitOperation::Export,
            json!({"files": [{"id": "c1", "value": value}]}),
        )
    };

    // The first workspace pushes its collection, on a branch named as the remote's.
    run(&first, GitOperation::Init, json!({})).await.unwrap();
    let mut command = git(&adapter.root.join("local").join("first"), adapter.protocols);
    command.args(["symbolic-ref", "HEAD", "refs/heads/main"]);
    assert!(run_for(command, TIMEOUT).await.unwrap().status.success());
    run(&first, GitOperation::RemoteAdd, json!({"url": url}))
        .await
        .unwrap();
    export(&first, json!({"info": {"name": "Shop"}, "item": []}))
        .await
        .unwrap();
    run(&first, GitOperation::Commit, json!({"message": "Add shop"}))
        .await
        .unwrap();
    let pushed = run(&first, GitOperation::Push, json!({})).await.unwrap();
    assert_eq!(pushed["success"], true, "{pushed}");

    // A new workspace clones it and reads its collections back.
    let cloned = run(&second, GitOperation::Clone, json!({"url": url}))
        .await
        .unwrap();
    assert_eq!(cloned["success"], true, "{cloned}");
    let files = run(&second, GitOperation::Files, json!({})).await.unwrap();
    assert_eq!(
        files["files"],
        json!([{"id": "c1", "value": {"info": {"name": "Shop"}, "item": []}}])
    );
    let status = run(&second, GitOperation::Status, json!({})).await.unwrap();
    assert!(
        status["stdout"]
            .as_str()
            .unwrap()
            .contains("# branch.head main")
    );

    // The second pushes a change; the first fetches it, sees it behind, and pulls.
    export(&second, json!({"info": {"name": "Shop v2"}, "item": []}))
        .await
        .unwrap();
    run(&second, GitOperation::Commit, json!({"message": "Rename"}))
        .await
        .unwrap();
    assert_eq!(
        run(&second, GitOperation::Push, json!({})).await.unwrap()["success"],
        true
    );
    run(&first, GitOperation::Fetch, json!({})).await.unwrap();
    let status = run(&first, GitOperation::Status, json!({})).await.unwrap();
    assert!(
        status["stdout"]
            .as_str()
            .unwrap()
            .contains("# branch.ab +0 -1"),
        "{status}"
    );
    let pulled = run(&first, GitOperation::Pull, json!({})).await.unwrap();
    assert_eq!(pulled["success"], true, "{pulled}");
    let files = run(&first, GitOperation::Files, json!({})).await.unwrap();
    assert_eq!(files["files"][0]["value"]["info"]["name"], "Shop v2");

    // Both change the same line: a fast-forward pull and a push are refused, a rebase
    // pull stops on the conflict and is undone.
    export(&first, json!({"info": {"name": "First"}, "item": []}))
        .await
        .unwrap();
    run(&first, GitOperation::Commit, json!({})).await.unwrap();
    export(&second, json!({"info": {"name": "Second"}, "item": []}))
        .await
        .unwrap();
    run(&second, GitOperation::Commit, json!({})).await.unwrap();
    run(&second, GitOperation::Push, json!({})).await.unwrap();
    assert!(message_of(run(&first, GitOperation::Push, json!({})).await).contains("Pull first"));
    assert!(
        message_of(run(&first, GitOperation::Pull, json!({})).await).contains("different commits")
    );
    assert!(
        message_of(run(&first, GitOperation::Pull, json!({"rebase": true})).await)
            .contains("undone")
    );
    let project = adapter.root.join("local").join("first");
    assert!(!project.join(".git").join("rebase-merge").exists());
    assert!(!project.join(".git").join("rebase-apply").exists());
    let files = run(&first, GitOperation::Files, json!({})).await.unwrap();
    assert_eq!(files["files"][0]["value"]["info"]["name"], "First");
    // Force with lease replaces the remote branch once it was fetched.
    run(&first, GitOperation::Fetch, json!({})).await.unwrap();
    let forced = run(&first, GitOperation::Push, json!({"forceWithLease": true}))
        .await
        .unwrap();
    assert_eq!(forced["success"], true, "{forced}");
    let _ = std::fs::remove_dir_all(root);
}
