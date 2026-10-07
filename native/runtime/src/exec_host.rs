// -*- coding: utf-8 -*-
//! exec_host.rs
//! Original Codex Execution Helper Host
//! =====================
//! Packages upstream helper dispatch for native Android command execution.

use std::time::Instant;

use codex_arg0::arg0_dispatch_or_else;
use codex_config::LoaderOverrides;
use codex_utils_cli::CliConfigOverrides;

/// Dispatch original execution helpers or run the original app-server.
///
/// Args:
///     None.
/// Returns:
///     Result<(), anyhow::Error>: Original helper or app-server completion state.
fn main() -> anyhow::Result<()> {
    let started = Instant::now();
    // Preserve upstream argv0 helper dispatch for command and filesystem subprocesses.
    arg0_dispatch_or_else(|paths| async move {
        let engine_started = Instant::now();
        let result = codex_app_server::run_main(
            paths,
            CliConfigOverrides::default(),
            LoaderOverrides::default(),
            false,
            false,
        ).await;
        let engine_duration = engine_started.elapsed();
        // Record the engine duration on the diagnostic stream while preserving protocol output.
        eprintln!("Engine duration: {} ms", engine_duration.as_millis());
        result.map_err(Into::into)
    })?;
    let total_duration = started.elapsed();
    // Record total invocation time after the original app-server completes.
    eprintln!("Total duration: {} ms", total_duration.as_millis());
    Ok(())
}
