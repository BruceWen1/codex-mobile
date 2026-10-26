// -*- coding: utf-8 -*-
//! mobile.rs
//! Native Mobile Tool and Task State
//! =====================
//! Executes granted file tools through the original protocol and tracks native task lifecycle.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use codex_app_server::in_process::InProcessClientSender;
use codex_app_server_protocol::{ClientRequest, RequestId};
use serde_json::{Value, json};

// Use a separate identifier namespace for host-owned original protocol requests.
static NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);

/// Pending original file-tool request.
/// Caches the execution result so a bridge-response retry preserves operation ownership.
#[derive(Clone)]
pub(super) struct PendingFile {
    pub request: Value,
    pub executing: bool,
    pub result: Option<Value>,
}

/// Native task and interaction state.
/// Remains available to the Android service independently of the WebView lifecycle.
#[derive(Default)]
pub(super) struct TaskState {
    pub turns: HashMap<String, String>,
    pub pending: HashMap<String, Value>,
    pub files: HashMap<String, PendingFile>,
    pub foreground_thread: String,
    pub starting: usize,
    pub executing_tools: usize,
}

impl TaskState {
    /// Observe an original task lifecycle notification.
    ///
    /// Args:
    ///     event (Value): Original app-server notification.
    /// Returns:
    ///     (): Native task and interaction state reflects the original engine.
    pub(super) fn observe(&mut self, event: &Value) {
        let params = &event["params"];
        // Track real turn identifiers for service lifetime and notification interruption.
        match event["method"].as_str() {
            Some("turn/started") => {
                // Require actual original identifiers before tracking a running turn.
                if let (Some(thread), Some(turn)) =
                    (params["threadId"].as_str(), params["turn"]["id"].as_str())
                {
                    self.turns.insert(thread.to_owned(), turn.to_owned());
                }
            }
            Some("turn/completed") => {
                // Remove only the turn reported complete by the engine.
                if let Some(thread) = params["threadId"].as_str() {
                    if self.turns.get(thread).map(String::as_str) == params["turn"]["id"].as_str() {
                        self.turns.remove(thread);
                    }
                }
            }
            Some("serverRequest/resolved") => {
                let id = params["requestId"].to_string();
                self.pending.remove(&id);
                self.files.remove(&id);
            }
            _ => {}
        }
    }

    /// Register an interactive request for replay and native file-tool execution.
    ///
    /// Args:
    ///     event (Value): Original server request requiring user input.
    /// Returns:
    ///     (): The request is available until the original engine resolves it.
    pub(super) fn register(&mut self, event: &Value) {
        let id = event["id"].to_string();
        self.pending.insert(id.clone(), event.clone());
        // Bind file-tool decisions to the actual engine request and its arguments.
        if is_file_tool(event) {
            self.files.insert(
                id,
                PendingFile {
                    request: event.clone(),
                    executing: false,
                    result: None,
                },
            );
        }
    }

    /// Export native service status without consuming any interface events.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     Value: Actual turns, interactions, and native work currently in progress.
    pub(super) fn status(&self) -> Value {
        let active_thread =
            (!self.turns.is_empty() || self.starting > 0).then_some(&self.foreground_thread);
        let waiting = !self.turns.is_empty()
            && self.starting == 0
            && self.executing_tools == 0
            && self.turns.keys().all(|thread| {
                self.pending
                    .values()
                    .any(|event| event["params"]["threadId"].as_str() == Some(thread.as_str()))
            });
        json!({
            "ready": true, "activeThreadId": active_thread,
            "lastThreadId": self.foreground_thread,
            "activeTurns": self.turns.iter().map(|(thread, turn)| json!({"threadId": thread, "turnId": turn})).collect::<Vec<_>>(),
            "pendingRequests": self.pending.len(), "startingTurns": self.starting,
            "executingTools": self.executing_tools, "waitingForUser": waiting
        })
    }
}

/// Identify an original mobile file-tool request.
///
/// Args:
///     event (Value): Original server request.
/// Returns:
///     bool: Whether this request belongs to the mobile filesystem adapter.
pub(super) fn is_file_tool(event: &Value) -> bool {
    event["method"] == "item/tool/call" && event["params"]["tool"] == "mobile_files"
}

/// Identify file inspections that execute under the existing directory grant.
///
/// Args:
///     event (Value): Original server request.
/// Returns:
///     bool: Whether the request requires native execution without a user decision.
pub(super) fn is_read_tool(event: &Value) -> bool {
    is_file_tool(event)
        && matches!(
            event["params"]["arguments"]["operation"].as_str(),
            Some("list" | "stat" | "read")
        )
}

/// Send one original app-server request from the native host.
///
/// Args:
///     sender (InProcessClientSender): Original embedded client sender.
///     root (Option<&str>): Directory boundary for a filesystem request.
///     method (str): Original protocol method.
///     params (Value): Original protocol parameters.
/// Returns:
///     Result<Value, String>: Actual original engine result or its reported error.
async fn request(
    sender: &InProcessClientSender,
    root: Option<&str>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let value = json!({"id": format!("mobile-native-{}", NEXT_REQUEST.fetch_add(1, Ordering::Relaxed)), "method": method, "params": params});
    // Validate actual filesystem paths before forwarding the unchanged original request.
    if let Some(root) = root {
        crate::workspace::validate(root, &value)?;
    }
    let request: ClientRequest =
        serde_json::from_value(value).map_err(|error| error.to_string())?;
    sender
        .request(request)
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.message)
}

/// Resolve the tool's relative path using the original thread directory.
///
/// Args:
///     root (str): Directory returned by the original thread API.
///     relative (Value): Actual relative path argument supplied by the engine.
/// Returns:
///     Result<PathBuf, String>: Absolute path with validated relative components.
fn relative_path(root: &str, relative: &Value) -> Result<PathBuf, String> {
    let relative = relative
        .as_str()
        .ok_or_else(|| "A relative file path is required".to_owned())?
        .replace('\\', "/");
    let path = Path::new(&relative);
    // Retain the existing mobile tool's relative-path contract on every platform.
    if path.is_absolute()
        || relative.as_bytes().get(1) == Some(&b':')
        || relative.contains('\0')
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("File paths must be relative to the current mobile directory".to_owned());
    }
    Ok(Path::new(root).join(path))
}

/// Execute the existing file operation through original filesystem methods.
///
/// Args:
///     sender (InProcessClientSender): Original embedded client sender.
///     root (str): Authoritative original thread directory.
///     args (Value): Actual original mobile tool arguments.
/// Returns:
///     Result<Value, String>: Actual filesystem result for the requested operation.
pub(super) async fn execute_at_root(
    sender: &InProcessClientSender,
    root: &str,
    args: &Value,
) -> Result<Value, String> {
    let path = relative_path(root, &args["path"])?;
    // Dispatch the existing tool operations with their original filesystem semantics.
    match args["operation"].as_str() {
        Some("list") => {
            request(
                sender,
                Some(root),
                "fs/readDirectory",
                json!({"path": path}),
            )
            .await
        }
        Some("stat") => request(sender, Some(root), "fs/getMetadata", json!({"path": path})).await,
        Some("read") => {
            let result = request(sender, Some(root), "fs/readFile", json!({"path": path})).await?;
            // Preserve binary data when the original request selects base64 encoding.
            if args["encoding"] == "base64" {
                return Ok(result);
            }
            let bytes = STANDARD
                .decode(result["dataBase64"].as_str().unwrap_or_default())
                .map_err(|error| error.to_string())?;
            Ok(json!({"content": String::from_utf8(bytes).map_err(|error| error.to_string())?}))
        }
        Some("write") => {
            let content = args["content"].as_str().unwrap_or_default();
            let data = if args["encoding"] == "base64" {
                content.to_owned()
            } else {
                STANDARD.encode(content.as_bytes())
            };
            request(
                sender,
                Some(root),
                "fs/writeFile",
                json!({"path": path, "dataBase64": data}),
            )
            .await
        }
        Some("mkdir") => {
            request(
                sender,
                Some(root),
                "fs/createDirectory",
                json!({"path": path, "recursive": true}),
            )
            .await
        }
        Some("copy" | "move") => {
            let destination = relative_path(root, &args["destination"])?;
            // Preserve the selected root and the existing recursive-copy boundary.
            if path == Path::new(root) || destination == path || destination.starts_with(&path) {
                return Err(
                    "Choose a file or subdirectory and an independent destination".to_owned(),
                );
            }
            let result = request(
                sender,
                Some(root),
                "fs/copy",
                json!({"sourcePath": path, "destinationPath": destination, "recursive": true}),
            )
            .await?;
            // Remove a move source only after the original engine reports a successful copy.
            if args["operation"] == "move" {
                request(
                    sender,
                    Some(root),
                    "fs/remove",
                    json!({"path": path, "recursive": true, "force": false}),
                )
                .await?;
            }
            Ok(result)
        }
        Some("delete") => {
            // Retain the selected directory while permitting operations on its contents.
            if path == Path::new(root) {
                return Err("Choose a file or subdirectory within the current directory".to_owned());
            }
            request(
                sender,
                Some(root),
                "fs/remove",
                json!({"path": path, "recursive": true, "force": false}),
            )
            .await
        }
        _ => Err("The mobile file operation is unsupported".to_owned()),
    }
}

/// Execute a tool using the directory owned by its original thread.
///
/// Args:
///     sender (InProcessClientSender): Original embedded client sender.
///     event (Value): Actual original file-tool request.
/// Returns:
///     Value: Original dynamic-tool result containing observed output or failure.
pub(super) async fn execute_tool(sender: &InProcessClientSender, event: &Value) -> Value {
    let result = async {
        let thread = event["params"]["threadId"]
            .as_str()
            .ok_or_else(|| "An original thread identifier is required".to_owned())?;
        let response = request(
            sender,
            None,
            "thread/read",
            json!({"threadId": thread, "includeTurns": false}),
        )
        .await?;
        let root = response["thread"]["cwd"]
            .as_str()
            .ok_or_else(|| "The original thread directory is unavailable".to_owned())?;
        execute_at_root(sender, root, &event["params"]["arguments"]).await
    }
    .await;
    // Return the same dynamic-tool content schema used by the original mobile adapter.
    match result {
        Ok(output) => {
            json!({"success": true, "contentItems": [{"type": "inputText", "text": output.to_string()}]})
        }
        Err(error) => {
            json!({"success": false, "contentItems": [{"type": "inputText", "text": error}]})
        }
    }
}

/// Deliver a server response with retry for original channel backpressure.
///
/// Args:
///     sender (InProcessClientSender): Original embedded client sender.
///     id (RequestId): Original server request identifier.
///     result (Value): Completed original dynamic-tool result.
/// Returns:
///     Result<(), String>: Response delivery or an actual channel failure.
pub(super) async fn respond(
    sender: &InProcessClientSender,
    id: RequestId,
    result: Value,
) -> Result<(), String> {
    // Retry queue saturation while preserving the completed operation result.
    loop {
        // Forward the original response without executing the operation again.
        match sender.respond_to_server_request(id.clone(), result.clone()) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                tokio::time::sleep(std::time::Duration::from_millis(25)).await
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

/// Resolve a file operation accepted or declined through the mobile interface.
///
/// Args:
///     sender (InProcessClientSender): Original embedded client sender.
///     state (Arc<Mutex<TaskState>>): Native pending-request and execution state.
///     id (Value): Original request identifier.
///     allow (bool): User decision for this original request.
/// Returns:
///     Result<(), String>: Original response delivery or a retryable bridge failure.
pub(super) async fn resolve_file(
    sender: &InProcessClientSender,
    state: &Arc<Mutex<TaskState>>,
    id: &Value,
    allow: bool,
) -> Result<(), String> {
    let key = id.to_string();
    let pending = {
        let mut state = state.lock().map_err(|error| error.to_string())?;
        let pending = state
            .files
            .get_mut(&key)
            .ok_or_else(|| "The original file request has already been resolved".to_owned())?;
        // Keep one native executor responsible for this request across interface retries.
        if pending.executing {
            return Err("The original file request is already executing".to_owned());
        }
        let snapshot = pending.clone();
        pending.executing = true;
        state.executing_tools += 1;
        snapshot
    };
    let result = match pending.result {
        Some(result) => result,
        None if allow => execute_tool(sender, &pending.request).await,
        None => {
            json!({"success": false, "contentItems": [{"type": "inputText", "text": "The user declined this operation."}]})
        }
    };
    {
        let mut state = state.lock().map_err(|error| error.to_string())?;
        state.executing_tools = state.executing_tools.saturating_sub(1);
        // Cache observed results while an original request remains available for response retry.
        if let Some(pending) = state.files.get_mut(&key) {
            pending.executing = false;
            pending.result = Some(result.clone());
        }
    }
    let id: RequestId = serde_json::from_value(id.clone()).map_err(|error| error.to_string())?;
    respond(sender, id, result).await
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    /// Verify service ownership and user-wait state from original lifecycle events.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     (): Assertions verify actual turn ownership, waiting state, and stale completion handling.
    #[test]
    fn tracks_original_turns_and_pending_user_requests() {
        let mut state = super::TaskState::default();
        state.foreground_thread = "thread-1".to_owned();
        state.observe(&json!({"method": "turn/started", "params": {"threadId": "thread-1", "turn": {"id": "turn-1"}}}));
        assert_eq!(state.status()["activeTurns"][0]["turnId"], "turn-1");
        assert_eq!(state.status()["activeThreadId"], "thread-1");
        // Mark a real interaction as waiting without granting or executing its operation.
        state.register(&json!({"id": 41, "method": "item/tool/call", "params": {"threadId": "thread-1", "tool": "mobile_files"}}));
        assert_eq!(state.status()["waitingForUser"], true);
        state.observe(&json!({"method": "serverRequest/resolved", "params": {"requestId": 41}}));
        assert_eq!(state.status()["pendingRequests"], 0);
        assert_eq!(state.status()["waitingForUser"], false);
        // Retain a newer turn when the previous turn's completion arrives late.
        state.observe(&json!({"method": "turn/started", "params": {"threadId": "thread-1", "turn": {"id": "turn-2"}}}));
        state.observe(&json!({"method": "turn/completed", "params": {"threadId": "thread-1", "turn": {"id": "turn-1"}}}));
        assert_eq!(state.status()["activeTurns"][0]["turnId"], "turn-2");
        state.observe(&json!({"method": "turn/completed", "params": {"threadId": "thread-1", "turn": {"id": "turn-2"}}}));
        assert!(state.status()["activeTurns"].as_array().unwrap().is_empty());
    }
}
