// -*- coding: utf-8 -*-
/**
 CodexRuntimePlugin.swift
 iOS Embedded Codex Host
 =====================
 Bridges the original Rust engine and maintains security-scoped directory grants.
 */
import Foundation
import SafariServices
import UIKit
import UniformTypeIdentifiers

import Capacitor

/**
 Initialize the original runtime through its C interface.

 Args:
     home (UnsafePointer<CChar>): Private native Codex state directory.
     workspace (UnsafePointer<CChar>): Initial working directory.
     executor (UnsafePointer<CChar>?): Packaged execution helper or nil.
 Returns:
     UnsafeMutablePointer<CChar>?: Owned UTF-8 JSON startup response.
 */
@_silgen_name("codex_mobile_start")
private func runtimeStart(_ home: UnsafePointer<CChar>, _ workspace: UnsafePointer<CChar>, _ executor: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>?
/**
 Dispatch an original protocol message through the C interface.

 Args:
     input (UnsafePointer<CChar>): Null-terminated original JSON-RPC message.
 Returns:
     UnsafeMutablePointer<CChar>?: Owned UTF-8 JSON protocol response.
 */
@_silgen_name("codex_mobile_request")
private func runtimeRequest(_ input: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?
/**
 Drain actual original engine events through the C interface.

 Args:
     None.
 Returns:
     UnsafeMutablePointer<CChar>?: Owned UTF-8 JSON event array.
 */
@_silgen_name("codex_mobile_poll")
private func runtimePoll() -> UnsafeMutablePointer<CChar>?
/**
 Release a response buffer allocated by the Rust runtime.

 Args:
     buffer (UnsafeMutablePointer<CChar>): Owned runtime buffer released exactly once.
 Returns:
     Void: The native response buffer is released.
 */
@_silgen_name("codex_mobile_free")
private func runtimeFree(_ buffer: UnsafeMutablePointer<CChar>)

/**
 Device-local Codex host.
 Holds granted directory scopes while the embedded engine uses their native paths.
 */
@objc(CodexRuntimePlugin)
public class CodexRuntimePlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "CodexRuntimePlugin"
    public let jsName = "CodexRuntime"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "poll", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "selectDirectory", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openUrl", returnType: CAPPluginReturnPromise),
    ]
    private var pickerCall: CAPPluginCall?
    private var scopedDirectories: [URL] = []

    /**
     Restore directory grants when the native plugin loads.

     Args:
         None.
     Returns:
         Void: Previously granted directory scopes are reopened when available.
     */
    public override func load() {
        let bookmarks = UserDefaults.standard.array(forKey: "codexDirectoryBookmarks") as? [Data] ?? []
        // Restore the actual system grants before resuming saved Codex sessions.
        for bookmark in bookmarks {
            var stale = false
            // Reopen each valid security-scoped directory bookmark.
            if let url = try? URL(resolvingBookmarkData: bookmark, options: .withoutUI, bookmarkDataIsStale: &stale), url.startAccessingSecurityScopedResource() {
                scopedDirectories.append(url)
            }
        }
    }

    /**
     Start the original embedded Codex engine.

     Args:
         call (CAPPluginCall): Native startup request.
     Returns:
         Void: The bridge receives the original engine startup response.
     */
    @objc public func start(_ call: CAPPluginCall) {
        DispatchQueue.global(qos: .userInitiated).async {
            // Resolve all native state paths from the current application container.
            let manager = FileManager.default
            let support = manager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            let documents = manager.urls(for: .documentDirectory, in: .userDomainMask)[0]
            let home = support.appendingPathComponent("codex", isDirectory: true)
            let workspace = documents.appendingPathComponent("workspace", isDirectory: true)
            home.path.withCString { homePath in
                workspace.path.withCString { workspacePath in
                    self.resolve(call, buffer: runtimeStart(homePath, workspacePath, nil))
                }
            }
        }
    }

    /**
     Dispatch an original app-server request or server-request response.

     Args:
         call (CAPPluginCall): Request containing the original JSON-RPC message.
     Returns:
         Void: The original engine result resolves the bridge request.
     */
    @objc public func request(_ call: CAPPluginCall) {
        // Require a complete protocol message before crossing the C boundary.
        guard let json = call.getString("json") else { call.reject("An original protocol message is required"); return }
        DispatchQueue.global(qos: .userInitiated).async {
            json.withCString { input in self.resolve(call, buffer: runtimeRequest(input)) }
        }
    }

    /**
     Deliver queued original engine events to the mobile interface.

     Args:
         call (CAPPluginCall): Native event polling request.
     Returns:
         Void: Actual queued events resolve the bridge request in order.
     */
    @objc public func poll(_ call: CAPPluginCall) {
        // Convert and release the event buffer owned by the Rust runtime.
        guard let buffer = runtimePoll() else { call.reject("The engine returned an empty buffer"); return }
        defer { runtimeFree(buffer) }
        let data = Data(String(cString: buffer).utf8)
        // Resolve only an actual serialized engine event array.
        guard let events = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { call.reject("The engine event array could not be decoded"); return }
        call.resolve(["events": events])
    }

    /**
     Present the system folder picker for a native directory grant.

     Args:
         call (CAPPluginCall): Directory selection request.
     Returns:
         Void: The native picker presents an operating-system-managed grant flow.
     */
    @objc public func selectDirectory(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            // Keep one native folder selection request active at a time.
            guard self.pickerCall == nil else { call.reject("A directory selection is already active"); return }
            self.pickerCall = call
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
            picker.delegate = self
            picker.allowsMultipleSelection = false
            self.bridge?.viewController?.present(picker, animated: true)
        }
    }

    /**
     Keep the actual selected directory accessible to the embedded Rust engine.

     Args:
         controller (UIDocumentPickerViewController): Native folder picker.
         urls ([URL]): Directories selected through the operating system.
     Returns:
         Void: A retained security scope and native path resolve the selection request.
     */
    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        // Require an actual security-scoped directory selected by the user.
        guard let url = urls.first, url.startAccessingSecurityScopedResource() else { pickerCall?.reject("所选目录无法访问。"); pickerCall = nil; return }
        scopedDirectories.append(url)
        // Persist a system-issued bookmark for future session continuation.
        if let data = try? url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil) {
            var bookmarks = UserDefaults.standard.array(forKey: "codexDirectoryBookmarks") as? [Data] ?? []
            bookmarks.append(data)
            UserDefaults.standard.set(bookmarks, forKey: "codexDirectoryBookmarks")
        }
        pickerCall?.resolve(["id": url.absoluteString, "name": url.lastPathComponent, "kind": "selected", "path": url.path])
        pickerCall = nil
    }

    /**
     Resolve cancellation of native folder selection.

     Args:
         controller (UIDocumentPickerViewController): Native folder picker.
     Returns:
         Void: The outstanding request receives its actual cancellation.
     */
    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pickerCall?.reject("目录选择已取消。")
        pickerCall = nil
    }

    /**
     Present the original Codex authorization page while keeping the host active.

     Args:
         call (CAPPluginCall): Request containing the original HTTPS authorization URL.
     Returns:
         Void: The upstream authorization page opens in a system browser surface.
     */
    @objc public func openUrl(_ call: CAPPluginCall) {
        // Require an HTTPS authorization URL before presenting the browser.
        guard let value = call.getString("url"), let url = URL(string: value), url.scheme == "https" else { call.reject("An HTTPS authorization URL is required"); return }
        DispatchQueue.main.async {
            self.bridge?.viewController?.present(SFSafariViewController(url: url), animated: true)
            call.resolve()
        }
    }

    /**
     Decode and release an actual Rust response buffer.

     Args:
         call (CAPPluginCall): Native request awaiting completion.
         buffer (UnsafeMutablePointer<CChar>?): Owned response from the runtime.
     Returns:
         Void: The actual protocol envelope resolves the bridge request.
     */
    private func resolve(_ call: CAPPluginCall, buffer: UnsafeMutablePointer<CChar>?) {
        // Require a valid buffer owned by the embedded runtime.
        guard let buffer else { call.reject("The engine returned an empty buffer"); return }
        defer { runtimeFree(buffer) }
        let data = Data(String(cString: buffer).utf8)
        // Decode the engine response without changing its protocol schema.
        guard let response = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { call.reject("The engine response could not be decoded"); return }
        call.resolve(response)
    }

    /**
     Release system directory scopes when the host is destroyed.

     Args:
         None.
     Returns:
         Void: Every retained security scope is released.
     */
    deinit {
        // Balance each actual system directory access grant.
        for directory in scopedDirectories { directory.stopAccessingSecurityScopedResource() }
    }
}
