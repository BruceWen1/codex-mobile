// -*- coding: utf-8 -*-
//! tests.rs
//! Embedded Original Codex Integration Verification
//! =====================
//! Exercises the original authentication and filesystem APIs in an isolated native home.

use serde_json::{Value, json};

/// Verify original account and filesystem behavior through the embedded host.
///
/// Args:
///     None.
/// Returns:
///     (): Assertions verify protocol compatibility and actual local file operations.
#[test]
fn embedded_codex_preserves_account_and_filesystem_protocol() {
    let fixture = tempfile::tempdir().expect("isolated fixture directory");
    let home = fixture.path().join("codex-home");
    let workspace = fixture.path().join("workspace");
    super::start_host(
        home.to_string_lossy().into_owned(),
        workspace.to_string_lossy().into_owned(),
        None,
    )
    .expect("embedded engine initialization");
    // Confirm the isolated host reads its own original authentication state.
    let account = request(1, "account/read", json!({"refreshToken": false}));
    assert!(account["account"].is_null());
    // Parse the original ChatGPT device authorization request without starting network login.
    let _: codex_app_server_protocol::ClientRequest = serde_json::from_value(json!({
        "id": 2, "method": "account/login/start", "params": {"type": "chatgptDeviceCode"}
    }))
    .expect("original ChatGPT device-code login schema");
    // Verify original API-key storage and account state with an isolated test credential.
    request(
        3,
        "account/login/start",
        json!({"type": "apiKey", "apiKey": "sk-isolated-mobile-fixture"}),
    );
    let account = request(4, "account/read", json!({"refreshToken": false}));
    assert_eq!(account["account"]["type"], "apiKey");
    request(5, "account/logout", json!({}));
    // Exercise actual file writes and reads through the original app-server filesystem API.
    let input = workspace.join("input.txt").to_string_lossy().into_owned();
    request(
        6,
        "fs/writeFile",
        json!({"path": input, "dataBase64": "SGVsbG8sIENvZGV4Lg=="}),
    );
    let read = request(7, "fs/readFile", json!({"path": input}));
    assert_eq!(read["dataBase64"], "SGVsbG8sIENvZGV4Lg==");
    // Dispatch a scoped request through the actual host and original filesystem processor.
    let scoped = super::dispatch(
        &json!({
            "id": 12, "method": "fs/readFile", "params": {"path": input},
            "mobileWorkspaceRoot": workspace
        })
        .to_string(),
    );
    assert_eq!(scoped["result"]["dataBase64"], "SGVsbG8sIENvZGV4Lg==");
    // Reject a request outside this tool's directory while retaining the original file.
    let denied = super::dispatch(
        &json!({
            "id": 13, "method": "fs/readFile", "params": {"path": home.join("auth.json")},
            "mobileWorkspaceRoot": workspace
        })
        .to_string(),
    );
    assert!(denied.get("error").is_some());
    let archive = workspace.join("archive").to_string_lossy().into_owned();
    request(
        8,
        "fs/createDirectory",
        json!({"path": archive, "recursive": true}),
    );
    let output = workspace
        .join("archive/output.txt")
        .to_string_lossy()
        .into_owned();
    request(
        9,
        "fs/copy",
        json!({"sourcePath": input, "destinationPath": output, "recursive": false}),
    );
    assert!(std::path::Path::new(&output).is_file());
    // Remove only the isolated fixture file created by this test.
    request(
        10,
        "fs/remove",
        json!({"path": input, "recursive": false, "force": false}),
    );
    assert!(!std::path::Path::new(&input).exists());
    let directory = request(11, "fs/readDirectory", json!({"path": workspace}));
    assert_eq!(
        directory["entries"]
            .as_array()
            .expect("directory entry array")
            .len(),
        1
    );
    let host = super::HOST.get().expect("running original host");
    // Exercise the native file executor with actual original filesystem requests and no WebView.
    let output = host
        .runtime
        .block_on(super::mobile::execute_at_root(
            &host.sender,
            workspace.to_str().unwrap(),
            &json!({
                "operation": "read", "path": "archive/output.txt"
            }),
        ))
        .expect("native background read through original filesystem");
    assert_eq!(output["content"], "Hello, Codex.");
    // Retain an unresolved original interaction across a native interface attachment.
    let pending = json!({"id": "fixture-pending", "method": "item/tool/call", "params": {
        "threadId": "fixture-thread", "tool": "mobile_files", "arguments": {"operation": "write", "path": "fixture.txt", "content": "fixture"}
    }});
    host.state.lock().unwrap().register(&pending);
    super::start_host(
        home.to_string_lossy().into_owned(),
        workspace.to_string_lossy().into_owned(),
        None,
    )
    .unwrap();
    let events = super::poll_events();
    assert_eq!(
        events
            .as_array()
            .unwrap()
            .iter()
            .filter(|event| event["id"] == "fixture-pending")
            .count(),
        1
    );
    // Resolve the isolated pending fixture without executing a file mutation.
    host.state.lock().unwrap().observe(
        &json!({"method": "serverRequest/resolved", "params": {"requestId": "fixture-pending"}}),
    );
}

/// Dispatch and validate one original protocol request in the integration fixture.
///
/// Args:
///     id (u64): Unique original protocol request identifier.
///     method (str): Original app-server method.
///     params (Value): Original request parameters.
/// Returns:
///     Value: Actual original protocol result.
fn request(id: u64, method: &str, params: Value) -> Value {
    let response =
        super::dispatch(&json!({"id": id, "method": method, "params": params}).to_string());
    assert!(response.get("error").is_none(), "{method}: {response}");
    response["result"].clone()
}
