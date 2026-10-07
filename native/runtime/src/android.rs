// -*- coding: utf-8 -*-
//! android.rs
//! Android JNI Runtime Bridge
//! =====================
//! Connects Android native calls to the same embedded Codex runtime.

use jni::JNIEnv;
use jni::objects::{JClass, JString};
use jni::sys::jstring;
use serde_json::json;
use std::path::PathBuf;

/// Start the embedded engine from Android.
///
/// Args:
///     env (JNIEnv): Current Android JNI environment.
///     class (JClass): Native host class.
///     home (JString): Private Codex home directory.
///     workspace (JString): Initial working directory.
///     executor (JString): Packaged original execution helper path.
/// Returns:
///     jstring: Original engine startup result serialized as JSON.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_codex_mobile_CodexRuntimePlugin_nativeStart(
    mut env: JNIEnv, _class: JClass, home: JString, workspace: JString, executor: JString,
) -> jstring {
    let result = (|| {
        let home: String = env.get_string(&home).map_err(|error| error.to_string())?.into();
        let workspace: String = env.get_string(&workspace).map_err(|error| error.to_string())?.into();
        let executor: String = env.get_string(&executor).map_err(|error| error.to_string())?.into();
        // Enable the original command backend only when its packaged helper exists.
        let executor = PathBuf::from(executor);
        super::start_host(home, workspace, executor.is_file().then_some(executor))
    })();
    // Serialize startup failures through the shared native result contract.
    let value = match result {
        Ok(value) => json!({"result": value}),
        Err(message) => json!({"error": {"message": message}}),
    };
    env.new_string(value.to_string()).map(JString::into_raw).unwrap_or(std::ptr::null_mut())
}

/// Dispatch an original app-server message from Android.
///
/// Args:
///     env (JNIEnv): Current Android JNI environment.
///     class (JClass): Native host class.
///     input (JString): Original JSON-RPC message.
/// Returns:
///     jstring: Original engine response serialized as JSON.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_codex_mobile_CodexRuntimePlugin_nativeRequest(
    mut env: JNIEnv, _class: JClass, input: JString,
) -> jstring {
    // Read the Java message while the JNI environment keeps it alive.
    let value = match env.get_string(&input) {
        Ok(input) => super::dispatch(&input.to_string_lossy()),
        Err(error) => json!({"error": {"message": error.to_string()}}),
    };
    env.new_string(value.to_string()).map(JString::into_raw).unwrap_or(std::ptr::null_mut())
}

/// Deliver queued original engine events to Android.
///
/// Args:
///     env (JNIEnv): Current Android JNI environment.
///     class (JClass): Native host class.
/// Returns:
///     jstring: Ordered engine event array serialized as JSON.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_codex_mobile_CodexRuntimePlugin_nativePoll(
    env: JNIEnv, _class: JClass,
) -> jstring {
    env.new_string(super::poll_events().to_string()).map(JString::into_raw).unwrap_or(std::ptr::null_mut())
}
