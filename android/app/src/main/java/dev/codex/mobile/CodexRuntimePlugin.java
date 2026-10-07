// -*- coding: utf-8 -*-
/**
 * CodexRuntimePlugin.java
 * Android Embedded Codex Host
 * =====================
 * Bridges the original Rust engine, authorization browser, and native directory grants.
 */
package dev.codex.mobile;

import android.Manifest;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.system.Os;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import androidx.activity.result.ActivityResult;
import androidx.appcompat.app.AlertDialog;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyStore;
import java.security.cert.X509Certificate;
import java.util.Base64;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

import org.json.JSONArray;

/**
 * Process-local Codex runtime host.
 * Credentials and history remain in the application's private native directory.
 */
@CapacitorPlugin(name = "CodexRuntime", permissions = {
    @Permission(alias = "storage", strings = {Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE})
})
public class CodexRuntimePlugin extends Plugin {
    private final ExecutorService workers = Executors.newFixedThreadPool(3);
    private String libraryError;
    private boolean certificatesConfigured;

    /**
     * Initialize native library availability.
     *
     * Args:
     *     None.
     * Returns:
     *     void: The runtime library is loaded or its actual load failure is retained.
     */
    @Override
    public void load() {
        // Load the engine packaged with the application for the current ABI.
        try {
            System.loadLibrary("codex_mobile_runtime");
        } catch (UnsatisfiedLinkError error) {
            libraryError = "此安装包尚未包含可运行的 Codex 内核。请完成原生内核构建。";
        }
    }

    /**
     * Initialize the embedded upstream engine.
     *
     * Args:
     *     call (PluginCall): Native interface request.
     * Returns:
     *     void: The startup result resolves the original bridge request.
     */
    @PluginMethod
    public void start(PluginCall call) {
        // Expose unavailable native builds before accepting any task.
        if (libraryError != null) { call.reject(libraryError); return; }
        workers.execute(() -> {
            File home = new File(getContext().getFilesDir(), ".codex");
            File workspace = new File(getContext().getFilesDir(), "workspace");
            // Supply the operating system's trusted roots to Codex's original TLS configuration.
            try { configureCertificates(home); }
            catch (Exception error) { call.reject(error.getMessage()); return; }
            // Initialize Codex using dynamically resolved private application paths.
            File executor = new File(getContext().getApplicationInfo().nativeLibraryDir, "libcodex_mobile_exec_host.so");
            resolveJson(call, nativeStart(home.getAbsolutePath(), workspace.getAbsolutePath(), executor.getAbsolutePath()));
        });
    }

    /**
     * Provide Android's actual trusted root certificates to the original Codex transport.
     *
     * Args:
     *     home (File): Private native Codex state directory.
     * Returns:
     *     void: Original TLS clients receive the platform-trusted certificate bundle.
     * Raises:
     *     Exception: System trust roots cannot be exported or configured.
     */
    private synchronized void configureCertificates(File home) throws Exception {
        // Resolve temporary files in the application's writable cache before engine startup.
        Os.setenv("TMPDIR", getContext().getCacheDir().getAbsolutePath(), true);
        // Reuse the platform certificate configuration for the process lifetime.
        if (certificatesConfigured) return;
        // Preserve an explicit original CLI certificate configuration when present.
        if (System.getenv("SSL_CERT_FILE") != null) { certificatesConfigured = true; return; }
        TrustManagerFactory factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        factory.init((KeyStore) null);
        StringBuilder pem = new StringBuilder();
        // Export the roots accepted by the application's actual platform trust manager.
        for (TrustManager manager : factory.getTrustManagers()) {
            // Export only X.509 roots used by the platform's TLS verifier.
            if (!(manager instanceof X509TrustManager)) continue;
            // Encode every actual platform trust anchor as a PEM certificate.
            for (X509Certificate certificate : ((X509TrustManager) manager).getAcceptedIssuers()) {
                pem.append("-----BEGIN CERTIFICATE-----\n");
                pem.append(Base64.getMimeEncoder(64, new byte[]{'\n'}).encodeToString(certificate.getEncoded()));
                pem.append("\n-----END CERTIFICATE-----\n");
            }
        }
        // Require actual trusted anchors before initializing any upstream network transport.
        if (pem.length() == 0) throw new IllegalStateException("Android trusted root certificates are unavailable");
        Files.createDirectories(home.toPath());
        File bundle = new File(home, "android-ca.pem");
        Files.write(bundle.toPath(), pem.toString().getBytes(StandardCharsets.US_ASCII));
        // Configure only this application process before its Codex networking workers start.
        Os.setenv("SSL_CERT_FILE", bundle.getAbsolutePath(), true);
        certificatesConfigured = true;
    }

    /**
     * Dispatch an original Codex protocol message.
     *
     * Args:
     *     call (PluginCall): Request containing the original JSON-RPC message.
     * Returns:
     *     void: The original engine response resolves the bridge request.
     */
    @PluginMethod
    public void request(PluginCall call) {
        // Require a packaged runtime and a complete original protocol message.
        if (libraryError != null) { call.reject(libraryError); return; }
        String json = call.getString("json");
        // Reject missing payloads before crossing the JNI boundary.
        if (json == null) { call.reject("An original protocol request is required"); return; }
        workers.execute(() -> resolveJson(call, nativeRequest(json)));
    }

    /**
     * Drain original engine notifications in order.
     *
     * Args:
     *     call (PluginCall): Event polling request.
     * Returns:
     *     void: The actual event array resolves the bridge request.
     */
    @PluginMethod
    public void poll(PluginCall call) {
        // Keep unavailable runtimes from invoking unresolved JNI methods.
        if (libraryError != null) { call.reject(libraryError); return; }
        try {
            JSObject result = new JSObject();
            result.put("events", new JSONArray(nativePoll()));
            call.resolve(result);
        } catch (Exception error) { call.reject(error.getMessage()); }
    }

    /**
     * Obtain storage permission and present the native folder picker.
     *
     * Args:
     *     call (PluginCall): Directory selection request.
     * Returns:
     *     void: A native directory grant or an actual denial resolves the request.
     */
    @PluginMethod
    public void selectDirectory(PluginCall call) {
        // Request direct shared-file access for Codex's existing path-based filesystem.
        if (Build.VERSION.SDK_INT >= 30 && !Environment.isExternalStorageManager()) {
            Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            startActivityForResult(call, intent, "storageGranted");
            return;
        }
        // Request legacy storage permissions on older Android releases.
        if (Build.VERSION.SDK_INT < 30 && getPermissionState("storage") != PermissionState.GRANTED) {
            requestPermissionForAlias("storage", call, "legacyStorageGranted");
            return;
        }
        pickDirectory(call);
    }

    /**
     * Continue folder selection after the system storage grant.
     *
     * Args:
     *     call (PluginCall): Original directory selection request.
     *     result (ActivityResult): System permission activity result.
     * Returns:
     *     void: Folder selection continues only after an actual grant.
     */
    @ActivityCallback
    private void storageGranted(PluginCall call, ActivityResult result) {
        // Verify the current system permission after the settings activity closes.
        if (Build.VERSION.SDK_INT >= 30 && Environment.isExternalStorageManager()) pickDirectory(call);
        else call.reject("文件访问权限尚未授予。");
    }

    /**
     * Continue folder selection after a legacy permission request.
     *
     * Args:
     *     call (PluginCall): Original directory selection request.
     * Returns:
     *     void: The folder picker opens after permission is granted.
     */
    @PermissionCallback
    private void legacyStorageGranted(PluginCall call) {
        // Verify permission before accessing legacy shared directories.
        if (getPermissionState("storage") == PermissionState.GRANTED) pickDirectory(call);
        else call.reject("文件访问权限尚未授予。");
    }

    /**
     * Present the available native storage volumes after the system grant.
     *
     * Args:
     *     call (PluginCall): Original directory selection request.
     * Returns:
     *     void: A native directory selection surface opens for the granted storage.
     */
    private void pickDirectory(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            List<File> volumes = new ArrayList<>();
            File primary = Environment.getExternalStorageDirectory();
            volumes.add(primary);
            // Include each mounted secondary storage volume discovered by Android.
            for (File external : getContext().getExternalFilesDirs(null)) {
                // Ignore unavailable mounted volumes.
                if (external == null) continue;
                File volume = external;
                // Resolve the volume above Android's package-specific directory hierarchy.
                for (int depth = 0; depth < 4 && volume != null; depth++) volume = volume.getParentFile();
                // Preserve a single entry for each readable native volume.
                if (volume != null && volume.canRead() && !volumes.contains(volume)) volumes.add(volume);
            }
            String[] names = new String[volumes.size()];
            // Label primary and removable native storage in the selection surface.
            for (int index = 0; index < volumes.size(); index++) names[index] = index == 0 ? "手机存储" : volumes.get(index).getName();
            new AlertDialog.Builder(getActivity())
                .setTitle("选择存储位置")
                .setItems(names, (dialog, which) -> showDirectoryPicker(call, volumes.get(which), volumes.get(which)))
                .setNegativeButton("取消", (dialog, which) -> call.reject("目录选择已取消。"))
                .setOnCancelListener(dialog -> call.reject("目录选择已取消。"))
                .show();
        });
    }

    /**
     * Browse directories inside an operating-system-authorized storage volume.
     *
     * Args:
     *     call (PluginCall): Original directory selection request.
     *     root (File): Native storage volume granted by the operating system.
     *     directory (File): Current directory displayed to the user.
     * Returns:
     *     void: The selected readable directory resolves the original bridge request.
     */
    private void showDirectoryPicker(PluginCall call, File root, File directory) {
        File[] children = directory.listFiles(File::isDirectory);
        // Require a directory that the current native grant can actually enumerate.
        if (children == null) { call.reject("所选目录无法访问。"); return; }
        java.util.Arrays.sort(children, (left, right) -> left.getName().compareToIgnoreCase(right.getName()));
        boolean hasParent = !directory.equals(root);
        String[] names = new String[children.length + (hasParent ? 1 : 0)];
        // Expose parent navigation within the current granted storage volume.
        if (hasParent) names[0] = "返回上级";
        // Display each actual native subdirectory.
        for (int index = 0; index < children.length; index++) names[index + (hasParent ? 1 : 0)] = children[index].getName();
        new AlertDialog.Builder(getActivity())
            .setTitle(directory.equals(root) ? "选择文件夹" : directory.getName())
            .setItems(names, (dialog, which) -> {
                // Navigate to the parent or selected child within this volume.
                File next = hasParent && which == 0 ? directory.getParentFile() : children[which - (hasParent ? 1 : 0)];
                showDirectoryPicker(call, root, next);
            })
            .setPositiveButton("使用此文件夹", (dialog, which) -> {
                // Resolve the actual selected path before passing it to the original engine.
                try {
                    String path = directory.getCanonicalPath();
                    String rootPath = root.getCanonicalPath();
                    // Keep the selected directory inside the granted storage volume.
                    if (!path.equals(rootPath) && !path.startsWith(rootPath + File.separator)) { call.reject("所选目录超出当前存储位置。"); return; }
                    JSObject selected = new JSObject();
                    selected.put("id", path); selected.put("kind", "selected");
                    selected.put("name", directory.equals(root) ? "手机存储" : directory.getName()); selected.put("path", path);
                    call.resolve(selected);
                } catch (Exception error) { call.reject(error.getMessage()); }
            })
            .setNegativeButton("取消", (dialog, which) -> call.reject("目录选择已取消。"))
            .setOnCancelListener(dialog -> call.reject("目录选择已取消。"))
            .show();
    }

    /**
     * Open the original Codex authorization URL.
     *
     * Args:
     *     call (PluginCall): Request containing the upstream HTTPS URL.
     * Returns:
     *     void: The system browser is opened for the original login flow.
     */
    @PluginMethod
    public void openUrl(PluginCall call) {
        Uri uri = Uri.parse(call.getString("url", ""));
        // Require an HTTPS authorization URL before launching the browser.
        if (!"https".equals(uri.getScheme())) { call.reject("An HTTPS authorization URL is required"); return; }
        getActivity().startActivity(new Intent(Intent.ACTION_VIEW, uri));
        call.resolve();
    }

    /**
     * Resolve an actual native JSON result.
     *
     * Args:
     *     call (PluginCall): Bridge request awaiting completion.
     *     json (String): Result produced by the embedded runtime.
     * Returns:
     *     void: The bridge request receives the actual result or serialization failure.
     */
    private void resolveJson(PluginCall call, String json) {
        try { call.resolve(new JSObject(json)); }
        catch (Exception error) { call.reject(error.getMessage()); }
    }

    /**
     * Release native bridge worker threads with the host activity.
     *
     * Args:
     *     None.
     * Returns:
     *     void: Native dispatch workers stop accepting new bridge requests.
     */
    @Override
    protected void handleOnDestroy() { workers.shutdown(); }

    /**
     * Invoke the Rust engine startup function.
     *
     * Args:
     *     home (String): Private Codex state directory.
     *     workspace (String): Initial working directory.
     *     executor (String): Original helper executable packaged with the application.
     * Returns:
     *     String: Original engine startup response.
     */
    private static native String nativeStart(String home, String workspace, String executor);

    /**
     * Invoke the original Rust protocol dispatcher.
     *
     * Args:
     *     json (String): Original JSON-RPC message.
     * Returns:
     *     String: Original app-server result.
     */
    private static native String nativeRequest(String json);

    /**
     * Drain the Rust event queue.
     *
     * Args:
     *     None.
     * Returns:
     *     String: Ordered original engine event array.
     */
    private static native String nativePoll();
}
