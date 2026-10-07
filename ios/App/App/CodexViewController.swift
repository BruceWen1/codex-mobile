// -*- coding: utf-8 -*-
/**
 CodexViewController.swift
 Codex Mobile iOS Entry Point
 =====================
 Registers the process-local runtime with the native interface container.
 */
import Capacitor

/**
 Mobile interface host.
 Registers the original Codex engine adapter when the native bridge is ready.
 */
class CodexViewController: CAPBridgeViewController {
    /**
     Register the process-local Codex plugin.

     Args:
         None.
     Returns:
         Void: The native runtime becomes available to the shared interface.
     */
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(CodexRuntimePlugin())
    }
}
