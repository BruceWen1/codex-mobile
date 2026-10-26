// -*- coding: utf-8 -*-
/**
 * CodexTaskService.java
 * Android Native Agent Task Service
 * =====================
 * Retains user-initiated Codex turns across activity backgrounding and screen locking.
 */
package dev.codex.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;

import androidx.core.app.NotificationCompat;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Process-local foreground task service.
 * Observes original engine status and offers task rejoin and interruption controls.
 */
public class CodexTaskService extends Service {
    // Use a stable low-priority notification for the active native task group.
    private static final String CHANNEL_ID = "codex_tasks";
    private static final int NOTIFICATION_ID = 101;
    static final String ACTION_STOP = "dev.codex.mobile.STOP_TASKS";
    static final String THREAD_EXTRA = "codexThreadId";
    // Keep initial service ownership until the queued native submission becomes visible.
    private static final long START_GRACE_MS = 30000;
    // Renew a bounded CPU wake lock only while original turns or native tools are running.
    private static final long WAKE_TIMEOUT_MS = 600000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private PowerManager.WakeLock wakeLock;
    private long startedAt;
    private long wakeUntil;
    private boolean observedWork;
    private boolean destroyed;
    private volatile boolean stopping;
    private String threadId = "";
    private String lastText = "";
    private String lastThreadId = "";

    /**
     * Initialize the task notification and native CPU ownership.
     *
     * Args:
     *     None.
     * Returns:
     *     void: The service is ready to retain an original native turn.
     */
    @Override
    public void onCreate() {
        super.onCreate();
        // Resolve native symbols when a notification recreates the service process.
        try { System.loadLibrary("codex_mobile_runtime"); }
        catch (UnsatisfiedLinkError error) { destroyed = true; stopSelf(); return; }
        startedAt = SystemClock.elapsedRealtime();
        NotificationManager notifications = getSystemService(NotificationManager.class);
        notifications.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "Codex 后台任务", NotificationManager.IMPORTANCE_LOW));
        PowerManager power = getSystemService(PowerManager.class);
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, getPackageName() + ":CodexTask");
        wakeLock.setReferenceCounted(false);
        Notification notification = notification("Codex 正在启动任务", true);
        // Declare the visible user-initiated agent workload on current Android versions.
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(NOTIFICATION_ID, notification);
        retainCpu(true);
    }

    /**
     * Begin status observation or interrupt tasks selected through the notification.
     *
     * Args:
     *     intent (Intent): Service command issued by the interface or notification.
     *     flags (int): Android service start flags.
     *     startId (int): Identifier for this service command.
     * Returns:
     *     int: The service runs for the actual process-local task lifetime.
     */
    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Finish an unavailable native host before scheduling service work.
        if (destroyed) return START_NOT_STICKY;
        // Apply a notification stop action through the original interruption protocol.
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopping = true;
            worker.execute(this::interruptTasks);
        } else {
            stopping = false;
            observedWork = false;
            startedAt = SystemClock.elapsedRealtime();
        }
        // Schedule one status reader for the process-local native engine.
        handler.removeCallbacksAndMessages(null);
        handler.post(this::pollStatus);
        return START_NOT_STICKY;
    }

    /**
     * Observe native engine status independently of interface event polling.
     *
     * Args:
     *     None.
     * Returns:
     *     void: A worker reads actual task identifiers and schedules the next status check.
     */
    private void pollStatus() {
        // Stop scheduling work after the actual service has been destroyed.
        if (destroyed) return;
        worker.execute(() -> {
            try {
                JSONObject status = new JSONObject(CodexRuntimePlugin.nativeStatus());
                handler.post(() -> updateStatus(status));
            } catch (Exception error) {
                handler.post(() -> finish("Codex 状态读取失败"));
            }
        });
    }

    /**
     * Update service lifetime and the visible notification from original task state.
     *
     * Args:
     *     status (JSONObject): Actual native task and pending-request status.
     * Returns:
     *     void: The service retains active work and releases completed task ownership.
     */
    private void updateStatus(JSONObject status) {
        // Ignore worker results that outlive service destruction.
        if (destroyed) return;
        JSONArray turns = status.optJSONArray("activeTurns");
        int active = turns == null ? 0 : turns.length();
        int starting = status.optInt("startingTurns");
        int tools = status.optInt("executingTools");
        int bridge = CodexRuntimePlugin.foregroundRequests.get();
        int pending = status.optInt("pendingRequests");
        threadId = status.optString("lastThreadId", threadId);
        boolean working = active > 0 || starting > 0 || tools > 0 || bridge > 0;
        observedWork = observedWork || working;
        // Release service ownership after completion or a rejected native startup.
        if (!status.optBoolean("ready") || (!working && (observedWork || SystemClock.elapsedRealtime() - startedAt >= START_GRACE_MS))) {
            finish("Codex 任务已结束");
            return;
        }
        String text = stopping ? "Codex 正在停止任务" : pending > 0 ? "Codex 等待你的确认，点击继续" : "Codex 正在后台执行任务";
        // Update the notification only when its actual task state changes.
        if (!text.equals(lastText) || !threadId.equals(lastThreadId)) {
            lastText = text;
            lastThreadId = threadId;
            getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, notification(text, true));
        }
        retainCpu((working && (!status.optBoolean("waitingForUser") || bridge > 0)) || (!observedWork && SystemClock.elapsedRealtime() - startedAt < START_GRACE_MS));
        // Interrupt a turn that became visible after a stop was requested during startup.
        if (stopping && active > 0) worker.execute(this::interruptTasks);
        handler.postDelayed(this::pollStatus, 1000);
    }

    /**
     * Retain CPU execution with a bounded and renewable native wake lock.
     *
     * Args:
     *     active (boolean): Whether an original turn or native tool is executing.
     * Returns:
     *     void: CPU ownership matches actual native task activity.
     */
    private void retainCpu(boolean active) {
        // Release safely when initialization ended before power ownership was created.
        if (wakeLock == null) return;
        // Acquire or renew the lock while the native task still owns execution.
        if (active && (!wakeLock.isHeld() || SystemClock.elapsedRealtime() >= wakeUntil - 60000)) {
            wakeLock.acquire(WAKE_TIMEOUT_MS);
            wakeUntil = SystemClock.elapsedRealtime() + WAKE_TIMEOUT_MS;
        }
        // Release CPU ownership when task execution has ended.
        if (!active && wakeLock.isHeld()) wakeLock.release();
    }

    /**
     * Build a notification that rejoins the original conversation and offers interruption.
     *
     * Args:
     *     text (String): Actual task state shown to the user.
     *     active (boolean): Whether the notification owns an active service task.
     * Returns:
     *     Notification: Native notification with original conversation navigation.
     */
    private Notification notification(String text, boolean active) {
        Intent open = new Intent(this, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(THREAD_EXTRA, threadId);
        PendingIntent content = PendingIntent.getActivity(this, NOTIFICATION_ID, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(dev.codex.mobile.R.drawable.codex_foreground)
            .setContentTitle("Codex")
            .setContentText(text)
            .setContentIntent(content)
            .setOnlyAlertOnce(true)
            .setOngoing(active)
            .setAutoCancel(!active)
            .setPriority(NotificationCompat.PRIORITY_LOW);
        // Offer an explicit stop action for the actual process-local native turn group.
        if (active) {
            Intent stop = new Intent(this, CodexTaskService.class).setAction(ACTION_STOP);
            PendingIntent action = PendingIntent.getForegroundService(this, NOTIFICATION_ID + 1, stop, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            builder.addAction(0, "停止任务", action);
        }
        return builder.build();
    }

    /**
     * Interrupt each actual native turn through the original app-server protocol.
     *
     * Args:
     *     None.
     * Returns:
     *     void: Original interruption requests have been delivered to current turns.
     */
    private void interruptTasks() {
        try {
            JSONArray turns = new JSONObject(CodexRuntimePlugin.nativeStatus()).optJSONArray("activeTurns");
            // Interrupt only identifiers actually reported by the current original engine.
            if (turns != null) {
                for (int index = 0; index < turns.length(); index++) {
                    JSONObject turn = turns.getJSONObject(index);
                    JSONObject request = new JSONObject().put("id", "mobile-stop-" + System.nanoTime())
                        .put("method", "turn/interrupt").put("params", turn);
                    CodexRuntimePlugin.nativeRequest(request.toString());
                }
            }
        } catch (Exception error) {
            handler.post(() -> finish("Codex 任务中断失败，请返回界面查看"));
        }
    }

    /**
     * Release foreground task ownership and retain a final conversation notification.
     *
     * Args:
     *     text (String): Actual completion or failure state.
     * Returns:
     *     void: Foreground and CPU ownership are released.
     */
    private void finish(String text) {
        // Finish once even when a worker result arrives after completion.
        if (destroyed) return;
        retainCpu(false);
        stopForeground(STOP_FOREGROUND_DETACH);
        getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, notification(text, false));
        stopSelf();
    }

    /**
     * Release task observation and native wake ownership during service teardown.
     *
     * Args:
     *     None.
     * Returns:
     *     void: Native service resources are released.
     */
    @Override
    public void onDestroy() {
        destroyed = true;
        handler.removeCallbacksAndMessages(null);
        retainCpu(false);
        worker.shutdown();
        super.onDestroy();
    }

    /**
     * Expose the started service lifecycle to Android.
     *
     * Args:
     *     intent (Intent): Optional Android binding request.
     * Returns:
     *     IBinder: Null for the Android started-service lifecycle.
     */
    @Override
    public IBinder onBind(Intent intent) { return null; }
}
