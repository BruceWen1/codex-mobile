// -*- coding: utf-8 -*-
//! lib.rs
//! Embedded Codex Mobile Runtime
//! =====================
//! Embeds the upstream app-server and exposes its original protocol to native clients.

use std::ffi::{CStr, CString, c_char};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use codex_app_server::in_process::{
    EmbeddedNetworkPolicy, InProcessClientSender, InProcessServerEvent, InProcessStartArgs,
};
use codex_app_server_protocol::{ClientRequest, InitializeParams, JSONRPCErrorError, RequestId};
use codex_arg0::Arg0DispatchPaths;
use codex_config::{CloudConfigBundleLoader, LoaderOverrides, NoopThreadConfigLoader};
use codex_core::config::{ConfigBuilder, ConfigOverrides};
use codex_exec_server::{EnvironmentManager, ExecServerRuntimeOptions};
use codex_feedback::CodexFeedback;
use codex_protocol::protocol::SessionSource;
use serde_json::{Value, json};
use tokio::runtime::Runtime;

mod events;
mod mobile;
mod workspace;

#[cfg(target_os = "android")]
mod android;

#[cfg(test)]
mod tests;

/// Embedded runtime state.
/// Owns the upstream client and the native notification queue.
struct Host {
    runtime: Runtime,
    sender: InProcessClientSender,
    events: Arc<Mutex<events::EventQueue>>,
    state: Arc<Mutex<mobile::TaskState>>,
    workspace: String,
    shell_available: bool,
}

// The engine lives for the native application's process lifetime.
// Upstream Codex owns authentication, credential refresh, history, and inference.
static HOST: OnceLock<Host> = OnceLock::new();
static START_LOCK: Mutex<()> = Mutex::new(());

// Limit queued native events while the WebView is paused, using upstream backpressure.
const EVENT_QUEUE_CAPACITY: usize = 2048;
// Bound each bridge response so a large backlog can be processed across multiple polls.
const EVENT_POLL_BATCH_SIZE: usize = 128;
// Identify the native bridge contract required by this packaged mobile interface.
const MOBILE_BRIDGE_VERSION: u32 = 2;

/// Initialize the original Codex engine inside the host application.
///
/// Args:
///     home (String): Private native directory for Codex credentials and history.
///     workspace (String): Initial working directory granted by the host.
///     executor (Option<PathBuf>): Packaged upstream helper executable when available.
/// Returns:
///     Result<Value, String>: Runtime identity and measured startup durations.
fn start_host(home: String, workspace: String, executor: Option<PathBuf>) -> Result<Value, String> {
    let total_started = Instant::now();
    let _guard = START_LOCK.lock().map_err(|error| error.to_string())?;
    // Return the existing engine when the native interface is recreated.
    if let Some(host) = HOST.get() {
        // Replay unresolved interactions after WebView or activity recreation.
        let state = host.state.lock().map_err(|error| error.to_string())?;
        let mut queue = host.events.lock().map_err(|error| error.to_string())?;
        for request in state.pending.values() {
            let _ = queue.push(request.clone());
        }
        drop(queue);
        drop(state);
        let status = runtime_status();
        return Ok(
            json!({"workspace": host.workspace, "ready": true, "shellAvailable": host.shell_available, "bridgeApiVersion": MOBILE_BRIDGE_VERSION, "activeThreadId": status["activeThreadId"]}),
        );
    }
    let home_path = PathBuf::from(&home);
    let workspace_path = PathBuf::from(&workspace);
    let shell_available = executor.as_ref().is_some_and(|path| path.is_file());
    std::fs::create_dir_all(&home_path).map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&workspace_path).map_err(|error| error.to_string())?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_stack_size(8 * 1024 * 1024)
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    let config_started = Instant::now();
    // Load the upstream configuration with a mobile-owned home and workspace.
    let (sender, events, state, config_ms) = runtime.block_on(async {
        // Retain the platform's shell capability across thread resume and configuration reload.
        let cli_overrides = vec![("features.shell_tool".to_owned(), shell_available.into())];
        let loader_overrides = LoaderOverrides::default();
        let policy = EmbeddedNetworkPolicy::load(&loader_overrides).await;
        let mut config = ConfigBuilder::default()
            .codex_home(home_path.clone())
            .cli_overrides(cli_overrides.clone())
            .harness_overrides(ConfigOverrides {
                cwd: Some(workspace_path),
                codex_self_exe: executor.clone(),
                main_execve_wrapper_exe: executor.clone(),
                ..Default::default()
            })
            .build()
            .await
            .map_err(|error| error.to_string())?;
        policy.activate(&mut config);
        // Resolve the actual native host identity required by the original local executor.
        let executable = match executor.clone() {
            Some(path) => path,
            None => std::env::current_exe().map_err(|error| error.to_string())?,
        };
        let runtime_paths =
            ExecServerRuntimeOptions::new(executable, None).map_err(|error| error.to_string())?;
        let manager = EnvironmentManager::from_codex_home(
            &home_path,
            Some(runtime_paths),
            config.http_client_factory(),
        )
        .await
        .map_err(|error| error.to_string())?;
        let config_ms = config_started.elapsed().as_millis();
        let initialize: InitializeParams = serde_json::from_value(json!({
            "clientInfo": {"name": "codex-mobile", "title": "Codex Mobile", "version": "0.1.0"},
            "capabilities": {"experimentalApi": true}
        }))
        .map_err(|error| error.to_string())?;
        let args = InProcessStartArgs {
            arg0_paths: Arg0DispatchPaths {
                codex_self_exe: executor.clone(),
                main_execve_wrapper_exe: executor,
                ..Default::default()
            },
            config: Arc::new(config),
            cli_overrides,
            loader_overrides,
            strict_config: false,
            cloud_config_bundle: CloudConfigBundleLoader::default(),
            embedded_network_policy: policy,
            thread_config_loader: Arc::new(NoopThreadConfigLoader),
            feedback: CodexFeedback::new(),
            log_db: None,
            state_db: None,
            environment_manager: Arc::new(manager),
            config_warnings: Vec::new(),
            session_source: SessionSource::Cli,
            enable_codex_api_key_env: false,
            initialize,
            channel_capacity: EVENT_QUEUE_CAPACITY,
        };
        let mut client = codex_app_server::in_process::start(args)
            .await
            .map_err(|error| error.to_string())?;
        let sender = client.sender();
        let events = Arc::new(Mutex::new(events::EventQueue::new(EVENT_QUEUE_CAPACITY)));
        let state = Arc::new(Mutex::new(mobile::TaskState::default()));
        let event_queue = events.clone();
        let task_state = state.clone();
        let task_sender = sender.clone();
        // Preserve server events while the native interface is paused.
        tokio::spawn(async move {
            while let Some(event) = client.next_event().await {
                // Serialize upstream notifications and requests without changing their schema.
                let value = match event {
                    InProcessServerEvent::ServerNotification(notification) => {
                        serde_json::to_value(notification)
                    }
                    InProcessServerEvent::ServerRequest(request) => serde_json::to_value(request),
                    InProcessServerEvent::Lagged { skipped } => Ok(json!({
                        "method": "mobile/lagged", "params": {"skipped": skipped}
                    })),
                };
                // Keep serialization failures visible to the mobile interface.
                let value = value.unwrap_or_else(|error| {
                    json!({
                        "method": "mobile/error", "params": {"message": error.to_string()}
                    })
                });
                // Track the original engine lifecycle independently of interface delivery.
                if let Ok(mut state) = task_state.lock() {
                    state.observe(&value);
                }
                // Remove cancelled requests before the interface can act on a stale event.
                if value["method"] == "serverRequest/resolved" {
                    if let Ok(mut queue) = event_queue.lock() {
                        queue.resolve(&value["params"]["requestId"]);
                    }
                }
                // Execute granted file inspections while the interface is paused or detached.
                if mobile::is_read_tool(&value) {
                    let sender = task_sender.clone();
                    let state = task_state.clone();
                    if let Ok(mut state) = state.lock() {
                        state.executing_tools += 1;
                    }
                    tokio::spawn(async move {
                        let output = mobile::execute_tool(&sender, &value).await;
                        // Deliver the actual observed result through the original response channel.
                        if let Ok(id) = serde_json::from_value(value["id"].clone()) {
                            let _ = mobile::respond(&sender, id, output).await;
                        }
                        // Release native work ownership after the original response is delivered.
                        if let Ok(mut state) = state.lock() {
                            state.executing_tools = state.executing_tools.saturating_sub(1);
                        }
                    });
                    continue;
                }
                // Retain interactive requests with their original arguments until resolution.
                if value.get("id").is_some() {
                    if let Ok(mut state) = task_state.lock() {
                        state.register(&value);
                    }
                }
                let overflow = event_queue
                    .lock()
                    .ok()
                    .and_then(|mut queue| queue.push(value).err());
                // Fail an overloaded interactive request explicitly back to the original engine.
                if let Some(request) = overflow {
                    if let Ok(mut state) = task_state.lock() {
                        let id = request["id"].to_string();
                        state.pending.remove(&id);
                        state.files.remove(&id);
                    }
                    let sender = task_sender.clone();
                    tokio::spawn(async move {
                        let Ok(id) = serde_json::from_value::<RequestId>(request["id"].clone())
                        else {
                            return;
                        };
                        let error = JSONRPCErrorError {
                            code: -32001,
                            message: "The mobile interaction queue is full".to_owned(),
                            data: None,
                        };
                        // Retry original channel backpressure until failure delivery is accepted.
                        loop {
                            match sender.fail_server_request(id.clone(), error.clone()) {
                                Ok(()) => break,
                                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                                    tokio::time::sleep(std::time::Duration::from_millis(25)).await
                                }
                                Err(_) => break,
                            }
                        }
                    });
                }
            }
        });
        Ok::<_, String>((sender, events, state, config_ms))
    })?;
    let total_ms = total_started.elapsed().as_millis();
    HOST.set(Host {
        runtime,
        sender,
        events,
        state,
        workspace: workspace.clone(),
        shell_available,
    })
    .map_err(|_| "Codex runtime is already initialized".to_owned())?;
    Ok(json!({
        "ready": true, "workspace": workspace,
        "shellAvailable": shell_available, "bridgeApiVersion": MOBILE_BRIDGE_VERSION,
        "startupMs": total_ms, "configurationMs": config_ms,
        "engineMs": total_ms.saturating_sub(config_ms)
    }))
}

/// Dispatch an original app-server request or a reply to a server request.
///
/// Args:
///     input (str): JSON-RPC request or response encoded as UTF-8.
/// Returns:
///     Value: Original protocol result or a structured error envelope.
fn dispatch(input: &str) -> Value {
    // Require a running embedded engine before accessing its protocol.
    let Some(host) = HOST.get() else {
        return json!({"error": {"message": "Codex runtime has not started"}});
    };
    let result = (|| -> Result<Value, String> {
        let mut value: Value = serde_json::from_str(input).map_err(|error| error.to_string())?;
        // Resolve actual upstream approval or tool requests through the same client channel.
        if value.get("method").is_none() {
            let id: RequestId =
                serde_json::from_value(value["id"].clone()).map_err(|error| error.to_string())?;
            // Execute only the original pending file operation accepted by this user decision.
            if let Some(allow) = value.get("mobileFileDecision").and_then(Value::as_bool) {
                host.runtime.block_on(mobile::resolve_file(
                    &host.sender,
                    &host.state,
                    &value["id"],
                    allow,
                ))?;
                return Ok(Value::Null);
            }
            // Forward explicit protocol errors when a native operation fails.
            if value.get("error").is_some() {
                let error = serde_json::from_value(value["error"].clone())
                    .map_err(|error| error.to_string())?;
                host.sender
                    .fail_server_request(id, error)
                    .map_err(|error| error.to_string())?;
            } else {
                host.sender
                    .respond_to_server_request(id, value["result"].clone())
                    .map_err(|error| error.to_string())?;
            }
            return Ok(Value::Null);
        }
        // Consume native directory metadata before forwarding the original request schema.
        if let Some(root) = value
            .as_object_mut()
            .and_then(|request| request.remove("mobileWorkspaceRoot"))
        {
            let root = root
                .as_str()
                .ok_or_else(|| "A mobile directory path is required".to_owned())?;
            workspace::validate(root, &value)?;
        }
        let method = value["method"].as_str().unwrap_or_default().to_owned();
        let starting = method == "turn/start";
        let request: ClientRequest =
            serde_json::from_value(value).map_err(|error| error.to_string())?;
        // Retain service ownership while the original turn-start request is still pending.
        if starting {
            host.state
                .lock()
                .map_err(|error| error.to_string())?
                .starting += 1;
        }
        let response = host.runtime.block_on(host.sender.request(request));
        if starting {
            let mut state = host.state.lock().map_err(|error| error.to_string())?;
            state.starting = state.starting.saturating_sub(1);
        }
        let response = response
            .map_err(|error| error.to_string())?
            .map_err(|error| error.message)?;
        // Retain the user's primary thread for service notifications and interface restoration.
        if matches!(method.as_str(), "thread/start" | "thread/resume") {
            if let Some(id) = response["thread"]["id"].as_str() {
                host.state
                    .lock()
                    .map_err(|error| error.to_string())?
                    .foreground_thread = id.to_owned();
            }
        }
        Ok(response)
    })();
    // Preserve the original result while exposing transport errors to the interface.
    match result {
        Ok(value) => json!({"result": value}),
        Err(message) => json!({"error": {"message": message}}),
    }
}

/// Drain pending upstream events for native delivery.
///
/// Args:
///     None.
/// Returns:
///     Value: An ordered array of actual engine events.
fn poll_events() -> Value {
    // Return an empty queue until the engine is running.
    let Some(host) = HOST.get() else {
        return json!([]);
    };
    // Deliver a bounded protocol batch before taking an authoritative interaction snapshot.
    let mut events = match host.events.lock() {
        Ok(mut queue) => queue
            .drain(EVENT_POLL_BATCH_SIZE - 1)
            .as_array()
            .cloned()
            .unwrap_or_default(),
        Err(error) => {
            vec![json!({"method": "mobile/error", "params": {"message": error.to_string()}})]
        }
    };
    // Clear stale interface approvals even when a cancellation notification was discarded.
    if let Ok(state) = host.state.lock() {
        let ids = state
            .pending
            .values()
            .map(|request| request["id"].clone())
            .collect::<Vec<_>>();
        events.push(json!({"method": "mobile/pendingRequests", "params": {"requestIds": ids}}));
    }
    Value::Array(events)
}

/// Read native task state without consuming interface notifications.
///
/// Args:
///     None.
/// Returns:
///     Value: Native service status reflecting original engine activity and pending input.
fn runtime_status() -> Value {
    // Return explicit idle status until the original runtime has started.
    let Some(host) = HOST.get() else {
        return json!({"ready": false, "activeTurns": [], "pendingRequests": 0, "startingTurns": 0, "executingTools": 0});
    };
    // Keep native service polling separate from interface event delivery.
    match host.state.lock() {
        Ok(state) => state.status(),
        Err(error) => json!({"error": {"message": error.to_string()}}),
    }
}

/// Convert a JSON value to an owned native UTF-8 buffer.
///
/// Args:
///     value (Value): Result or event payload to serialize.
/// Returns:
///     *mut c_char: Buffer released by codex_mobile_free.
fn into_buffer(value: Value) -> *mut c_char {
    CString::new(value.to_string())
        .unwrap_or_default()
        .into_raw()
}

/// Start Codex through the native C interface.
///
/// Args:
///     home (*const c_char): Valid null-terminated private home path.
///     workspace (*const c_char): Valid null-terminated workspace path.
///     executor (*const c_char): Packaged helper path, or null for a filesystem host.
/// Returns:
///     *mut c_char: Owned JSON result or error buffer.
/// Safety:
///     Both pointers must remain valid throughout the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn codex_mobile_start(
    home: *const c_char,
    workspace: *const c_char,
    executor: *const c_char,
) -> *mut c_char {
    // Reject invalid native inputs before dereferencing them.
    if home.is_null() || workspace.is_null() {
        return into_buffer(json!({"error": {"message": "Native paths are required"}}));
    }
    // Read native paths whose lifetime is guaranteed by the caller.
    let home = unsafe { CStr::from_ptr(home) }
        .to_string_lossy()
        .into_owned();
    let workspace = unsafe { CStr::from_ptr(workspace) }
        .to_string_lossy()
        .into_owned();
    // Accept a packaged helper only when the native platform supplies one.
    let executor = if executor.is_null() {
        None
    } else {
        Some(PathBuf::from(
            unsafe { CStr::from_ptr(executor) }
                .to_string_lossy()
                .into_owned(),
        ))
    };
    // Convert startup failures into the shared native result contract.
    into_buffer(match start_host(home, workspace, executor) {
        Ok(value) => json!({"result": value}),
        Err(message) => json!({"error": {"message": message}}),
    })
}

/// Send an app-server message through the native C interface.
///
/// Args:
///     input (*const c_char): Valid null-terminated JSON message.
/// Returns:
///     *mut c_char: Owned JSON response buffer.
/// Safety:
///     The input pointer must remain valid throughout the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn codex_mobile_request(input: *const c_char) -> *mut c_char {
    // Reject a missing message before dereferencing the native pointer.
    if input.is_null() {
        return into_buffer(json!({"error": {"message": "A request is required"}}));
    }
    // Borrow the native message while the caller keeps it alive.
    let input = unsafe { CStr::from_ptr(input) }.to_string_lossy();
    into_buffer(dispatch(&input))
}

/// Receive queued events through the native C interface.
///
/// Args:
///     None.
/// Returns:
///     *mut c_char: Owned JSON event array.
#[unsafe(no_mangle)]
pub extern "C" fn codex_mobile_poll() -> *mut c_char {
    into_buffer(poll_events())
}

/// Release a buffer allocated by this runtime.
///
/// Args:
///     buffer (*mut c_char): Buffer previously returned by the runtime.
/// Returns:
///     (): The buffer is released exactly once.
/// Safety:
///     The pointer must originate from this runtime and must not have been freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn codex_mobile_free(buffer: *mut c_char) {
    // Release an owned buffer when the native caller provides one.
    if !buffer.is_null() {
        drop(unsafe { CString::from_raw(buffer) });
    }
}
