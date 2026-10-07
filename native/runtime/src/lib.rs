// -*- coding: utf-8 -*-
//! lib.rs
//! Embedded Codex Mobile Runtime
//! =====================
//! Embeds the upstream app-server and exposes its original protocol to native clients.

use std::collections::VecDeque;
use std::ffi::{CStr, CString, c_char};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use codex_app_server::in_process::{
    EmbeddedNetworkPolicy, InProcessClientSender, InProcessServerEvent, InProcessStartArgs,
};
use codex_app_server_protocol::{ClientRequest, InitializeParams, RequestId};
use codex_arg0::Arg0DispatchPaths;
use codex_config::{CloudConfigBundleLoader, LoaderOverrides, NoopThreadConfigLoader};
use codex_core::config::{ConfigBuilder, ConfigOverrides};
use codex_exec_server::{EnvironmentManager, ExecServerRuntimeOptions};
use codex_feedback::CodexFeedback;
use codex_protocol::protocol::SessionSource;
use serde_json::{Value, json};
use tokio::runtime::Runtime;

#[cfg(target_os = "android")]
mod android;

#[cfg(test)]
mod tests;

/// Embedded runtime state.
/// Owns the upstream client and the native notification queue.
struct Host {
    runtime: Runtime,
    sender: InProcessClientSender,
    events: Arc<Mutex<VecDeque<Value>>>,
    workspace: String,
    shell_available: bool,
}

// The engine lives for the native application's process lifetime.
// Upstream Codex owns authentication, credential refresh, history, and inference.
static HOST: OnceLock<Host> = OnceLock::new();
static START_LOCK: Mutex<()> = Mutex::new(());

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
        return Ok(json!({"workspace": host.workspace, "ready": true, "shellAvailable": host.shell_available}));
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
    let (sender, events, config_ms) = runtime.block_on(async {
        let loader_overrides = LoaderOverrides::default();
        let policy = EmbeddedNetworkPolicy::load(&loader_overrides).await;
        let mut config = ConfigBuilder::default()
            .codex_home(home_path.clone())
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
        let runtime_paths = ExecServerRuntimeOptions::new(executable, None)
            .map_err(|error| error.to_string())?;
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
            cli_overrides: Vec::new(),
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
            channel_capacity: 2048,
        };
        let mut client = codex_app_server::in_process::start(args)
            .await
            .map_err(|error| error.to_string())?;
        let sender = client.sender();
        let events = Arc::new(Mutex::new(VecDeque::new()));
        let event_queue = events.clone();
        // Preserve server events while the native interface is paused.
        tokio::spawn(async move {
            while let Some(event) = client.next_event().await {
                // Serialize upstream notifications and requests without changing their schema.
                let value = match event {
                    InProcessServerEvent::ServerNotification(notification) => serde_json::to_value(notification),
                    InProcessServerEvent::ServerRequest(request) => serde_json::to_value(request),
                    InProcessServerEvent::Lagged { skipped } => Ok(json!({
                        "method": "mobile/lagged", "params": {"skipped": skipped}
                    })),
                };
                // Keep serialization failures visible to the mobile interface.
                let value = value.unwrap_or_else(|error| json!({
                    "method": "mobile/error", "params": {"message": error.to_string()}
                }));
                // Append actual events to the native delivery queue.
                if let Ok(mut queue) = event_queue.lock() {
                    queue.push_back(value);
                }
            }
        });
        Ok::<_, String>((sender, events, config_ms))
    })?;
    let total_ms = total_started.elapsed().as_millis();
    HOST.set(Host { runtime, sender, events, workspace: workspace.clone(), shell_available })
        .map_err(|_| "Codex runtime is already initialized".to_owned())?;
    Ok(json!({
        "ready": true, "workspace": workspace,
        "shellAvailable": shell_available,
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
        let value: Value = serde_json::from_str(input).map_err(|error| error.to_string())?;
        // Resolve actual upstream approval or tool requests through the same client channel.
        if value.get("method").is_none() {
            let id: RequestId = serde_json::from_value(value["id"].clone()).map_err(|error| error.to_string())?;
            // Forward explicit protocol errors when a native operation fails.
            if value.get("error").is_some() {
                let error = serde_json::from_value(value["error"].clone()).map_err(|error| error.to_string())?;
                host.sender.fail_server_request(id, error).map_err(|error| error.to_string())?;
            } else {
                host.sender.respond_to_server_request(id, value["result"].clone()).map_err(|error| error.to_string())?;
            }
            return Ok(Value::Null);
        }
        let request: ClientRequest = serde_json::from_value(value).map_err(|error| error.to_string())?;
        let response = host.runtime.block_on(host.sender.request(request)).map_err(|error| error.to_string())?;
        response.map_err(|error| error.message)
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
    let Some(host) = HOST.get() else { return json!([]); };
    // Deliver every queued event while releasing the queue before returning.
    match host.events.lock() {
        Ok(mut queue) => Value::Array(queue.drain(..).collect()),
        Err(error) => json!([{"method": "mobile/error", "params": {"message": error.to_string()}}]),
    }
}

/// Convert a JSON value to an owned native UTF-8 buffer.
///
/// Args:
///     value (Value): Result or event payload to serialize.
/// Returns:
///     *mut c_char: Buffer released by codex_mobile_free.
fn into_buffer(value: Value) -> *mut c_char {
    CString::new(value.to_string()).unwrap_or_default().into_raw()
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
pub unsafe extern "C" fn codex_mobile_start(home: *const c_char, workspace: *const c_char, executor: *const c_char) -> *mut c_char {
    // Reject invalid native inputs before dereferencing them.
    if home.is_null() || workspace.is_null() {
        return into_buffer(json!({"error": {"message": "Native paths are required"}}));
    }
    // Read native paths whose lifetime is guaranteed by the caller.
    let home = unsafe { CStr::from_ptr(home) }.to_string_lossy().into_owned();
    let workspace = unsafe { CStr::from_ptr(workspace) }.to_string_lossy().into_owned();
    // Accept a packaged helper only when the native platform supplies one.
    let executor = if executor.is_null() { None } else {
        Some(PathBuf::from(unsafe { CStr::from_ptr(executor) }.to_string_lossy().into_owned()))
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
    if input.is_null() { return into_buffer(json!({"error": {"message": "A request is required"}})); }
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
pub extern "C" fn codex_mobile_poll() -> *mut c_char { into_buffer(poll_events()) }

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
    if !buffer.is_null() { drop(unsafe { CString::from_raw(buffer) }); }
}
