// -*- coding: utf-8 -*-
/**
 * MainActivity.java
 * Codex Mobile Android Entry Point
 * =====================
 * Registers the native Codex host before loading the mobile interface.
 */
package dev.codex.mobile;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

/**
 * Mobile application activity.
 * Hosts the shared interface and the embedded upstream Rust engine.
 */
public class MainActivity extends BridgeActivity {
    /**
     * Register the device-local engine and initialize the application.
     *
     * Args:
     *     savedInstanceState (Bundle): Previous Android activity state.
     * Returns:
     *     void: The native plugin and mobile interface are initialized.
     */
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register the native engine before initializing the web container.
        registerPlugin(CodexRuntimePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
