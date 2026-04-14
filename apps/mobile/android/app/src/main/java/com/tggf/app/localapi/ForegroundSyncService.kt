package com.tggf.app.localapi

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.tggf.app.MainActivity
import com.tggf.app.R
import kotlin.math.max

class ForegroundSyncService : Service() {
    companion object {
        private const val PREFS_NAME = "tg_gf_runtime_prefs"
        private const val PREF_KEEP_ALIVE_ENABLED = "keep_alive_enabled"
        private const val ACTION_START = "com.tggf.app.localapi.action.START_FOREGROUND_SYNC"
        private const val ACTION_STOP = "com.tggf.app.localapi.action.STOP_FOREGROUND_SYNC"
        private const val ACTION_REFRESH_NOTIFICATION =
            "com.tggf.app.localapi.action.REFRESH_FOREGROUND_SYNC_NOTIFICATION"

        const val CHANNEL_ID = "tg_gf_foreground_sync"
        const val NOTIFICATION_ID = 7001
        const val HEARTBEAT_INTERVAL_MS = 2_000L
        const val WORKER_TOPIC_GENERATION = "topic_generation"
        const val WORKER_GROUP_ITERATION = "group_iteration"

        private const val TOPIC_STALE_THRESHOLD_MS = 20_000L
        private const val GROUP_STALE_THRESHOLD_MS = 30_000L
        private const val METRICS_CACHE_TTL_MS = 4_000L
        private val workerStatusByType = mutableMapOf<String, WorkerStatusSnapshot>()
        private val workerStatusLock = Any()
        private var activeService: ForegroundSyncService? = null

        data class WorkerStatusSnapshot(
            val worker: String,
            val state: String,
            val scopeId: String,
            val detail: String,
            val heartbeatAtMs: Long,
            val progressAtMs: Long,
            val claimAtMs: Long,
            val lastError: String,
        )

        @Volatile
        private var running = false

        @JvmStatic
        fun isRunning(): Boolean = running

        @JvmStatic
        fun isEnabled(context: Context): Boolean {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            return prefs.getBoolean(PREF_KEEP_ALIVE_ENABLED, true)
        }

        @JvmStatic
        fun setEnabled(context: Context, enabled: Boolean) {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            prefs.edit().putBoolean(PREF_KEEP_ALIVE_ENABLED, enabled).apply()
            if (enabled) {
                start(context)
            } else {
                stop(context)
            }
        }

        @JvmStatic
        fun ensureStartedIfEnabled(context: Context) {
            if (isEnabled(context)) {
                start(context)
            }
        }

        @JvmStatic
        fun start(context: Context) {
            val intent = Intent(context, ForegroundSyncService::class.java).apply {
                action = ACTION_START
            }
            ContextCompat.startForegroundService(context, intent)
        }

        @JvmStatic
        fun stop(context: Context) {
            val intent = Intent(context, ForegroundSyncService::class.java).apply {
                action = ACTION_STOP
            }
            ContextCompat.startForegroundService(context, intent)
        }

        @JvmStatic
        fun updateWorkerStatus(
            context: Context,
            worker: String,
            state: String,
            scopeId: String,
            detail: String,
            progress: Boolean,
            claimed: Boolean,
            lastError: String,
        ) {
            val now = System.currentTimeMillis()
            synchronized(workerStatusLock) {
                val current = workerStatusByType[worker]
                val next = WorkerStatusSnapshot(
                    worker = worker,
                    state = state,
                    scopeId = scopeId,
                    detail = detail,
                    heartbeatAtMs = now,
                    progressAtMs = if (progress) now else current?.progressAtMs ?: 0L,
                    claimAtMs = if (claimed) now else current?.claimAtMs ?: 0L,
                    lastError =
                        if (lastError.isNotBlank()) {
                            lastError
                        } else if (state != "error") {
                            ""
                        } else {
                            current?.lastError ?: ""
                        },
                )
                workerStatusByType[worker] = next
            }
            activeService?.refreshNotification()
            if (activeService == null && isEnabled(context) && isRunning()) {
                val intent = Intent(context, ForegroundSyncService::class.java).apply {
                    action = ACTION_REFRESH_NOTIFICATION
                }
                ContextCompat.startForegroundService(context, intent)
            }
        }

        @JvmStatic
        fun getWorkerStatusSnapshots(): List<WorkerStatusSnapshot> {
            synchronized(workerStatusLock) {
                return workerStatusByType.values
                    .map { it.copy() }
                    .sortedBy { it.worker }
            }
        }

        @JvmStatic
        fun isWorkerStale(worker: String, heartbeatAtMs: Long, nowMs: Long): Boolean {
            if (heartbeatAtMs <= 0L) return true
            val threshold = when (worker) {
                WORKER_TOPIC_GENERATION -> TOPIC_STALE_THRESHOLD_MS
                WORKER_GROUP_ITERATION -> GROUP_STALE_THRESHOLD_MS
                else -> GROUP_STALE_THRESHOLD_MS
            }
            return nowMs - heartbeatAtMs > threshold
        }

        @JvmStatic
        fun isWorkerSnapshotStale(snapshot: WorkerStatusSnapshot, nowMs: Long): Boolean {
            if (snapshot.state.equals("idle", ignoreCase = true)) return false
            return isWorkerStale(
                worker = snapshot.worker,
                heartbeatAtMs = snapshot.heartbeatAtMs,
                nowMs = nowMs,
            )
        }
    }

    private val heartbeatHandler = Handler(Looper.getMainLooper())
    private var heartbeatRunnable: Runnable? = null
    private var heartbeatSequence = 0L
    private var wakeLock: PowerManager.WakeLock? = null
    private var notificationMetricsCache: NotificationMetrics? = null
    private var notificationMetricsCacheAtMs: Long = 0L

    private data class NotificationMetrics(
        val topicDoneCount: Int,
        val topicFailedCount: Int,
        val topicEnabledCount: Int,
        val topicPendingCount: Int,
        val topicLeasedCount: Int,
        val groupDoneCount: Int,
        val groupFailedCount: Int,
        val groupEnabledCount: Int,
        val groupPendingCount: Int,
        val groupLeasedCount: Int,
    ) {
        val totalPendingCount: Int
            get() = topicPendingCount + groupPendingCount

        val totalLeasedCount: Int
            get() = topicLeasedCount + groupLeasedCount
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureNotificationChannel()
        running = true
        activeService = this
        acquireWakeLock()
        startHeartbeatLoop()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopHeartbeatLoop()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE)
            } else {
                @Suppress("DEPRECATION")
                stopForeground(true)
            }
            stopSelf()
            return START_NOT_STICKY
        }

        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        if (intent?.action == ACTION_REFRESH_NOTIFICATION) {
            refreshNotification()
        }
        return START_REDELIVER_INTENT
    }

    override fun onDestroy() {
        stopHeartbeatLoop()
        releaseWakeLock()
        if (activeService === this) {
            activeService = null
        }
        running = false
        super.onDestroy()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        if (isEnabled(applicationContext)) {
            start(applicationContext)
        }
        super.onTaskRemoved(rootIntent)
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return

        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.foreground_service_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.foreground_service_channel_description)
            setShowBadge(false)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val now = System.currentTimeMillis()
        val metrics = getNotificationMetrics(now)
        val statusSummary = buildNotificationStatusSummary(now, metrics)
        val statusDetails = buildNotificationStatusDetails(now, metrics)

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
            .setContentTitle(getString(R.string.foreground_service_notification_title))
            .setContentText(
                if (statusSummary.isNotBlank()) {
                    statusSummary
                } else {
                    getString(R.string.foreground_service_notification_text)
                },
            )
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setAutoCancel(false)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setStyle(
                NotificationCompat.BigTextStyle().bigText(
                    if (statusDetails.isNotBlank()) {
                        statusDetails
                    } else {
                        getString(R.string.foreground_service_notification_text)
                    },
                ),
            )

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        }

        return builder.build().apply {
            flags = flags or Notification.FLAG_ONGOING_EVENT or Notification.FLAG_NO_CLEAR
        }
    }

    private fun startHeartbeatLoop() {
        if (heartbeatRunnable != null) return
        heartbeatRunnable = object : Runnable {
            override fun run() {
                if (!running) return
                heartbeatSequence += 1
                BackgroundRuntimeEngine.requestTick(applicationContext)
                LocalApiBridgePlugin.emitBackgroundTick(
                    source = "foreground_service",
                    sequence = heartbeatSequence,
                    intervalMs = HEARTBEAT_INTERVAL_MS,
                    enabled = isEnabled(applicationContext),
                    running = isRunning(),
                )
                TopicGenerationNativeExecutor.requestTick(applicationContext)
                GroupIterationNativeExecutor.requestTick(applicationContext)
                val now = System.currentTimeMillis()
                if (shouldPulseWebView(now)) {
                    MainActivity.pulseWebViewFromService("heartbeat_$heartbeatSequence")
                }
                refreshNotification()
                heartbeatHandler.postDelayed(this, HEARTBEAT_INTERVAL_MS)
            }
        }
        heartbeatHandler.post(heartbeatRunnable!!)
    }

    private fun stopHeartbeatLoop() {
        val runnable = heartbeatRunnable ?: return
        heartbeatHandler.removeCallbacks(runnable)
        heartbeatRunnable = null
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        val manager = getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
        wakeLock = manager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "tg-gf:foreground-sync",
        ).apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    private fun releaseWakeLock() {
        val lock = wakeLock ?: return
        if (lock.isHeld) {
            lock.release()
        }
        wakeLock = null
    }

    private fun refreshNotification() {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        manager.notify(NOTIFICATION_ID, buildNotification())
    }

    private fun buildNotificationStatusSummary(nowMs: Long, metrics: NotificationMetrics): String {
        val snapshots = getWorkerStatusSnapshots()
        if (snapshots.isEmpty()) {
            if (
                metrics.totalPendingCount == 0 &&
                    metrics.totalLeasedCount == 0 &&
                    metrics.topicDoneCount == 0 &&
                    metrics.groupDoneCount == 0
            ) {
                return ""
            }
            return "GEN d${metrics.topicDoneCount}/e${metrics.topicFailedCount} | " +
                "GRP d${metrics.groupDoneCount}/e${metrics.groupFailedCount} | " +
                "Q p${metrics.totalPendingCount} l${metrics.totalLeasedCount}"
        }
        val topicLine = formatWorkerSummaryLine(
            label = "GEN",
            snapshot = snapshots.find { it.worker == WORKER_TOPIC_GENERATION },
            nowMs = nowMs,
            doneCount = metrics.topicDoneCount,
            failedCount = metrics.topicFailedCount,
        )
        val groupLine = formatWorkerSummaryLine(
            label = "GRP",
            snapshot = snapshots.find { it.worker == WORKER_GROUP_ITERATION },
            nowMs = nowMs,
            doneCount = metrics.groupDoneCount,
            failedCount = metrics.groupFailedCount,
        )
        val queueLine = "Q p${metrics.totalPendingCount} l${metrics.totalLeasedCount}"
        return listOf(topicLine, groupLine, queueLine).joinToString(" | ").trim()
    }

    private fun buildNotificationStatusDetails(nowMs: Long, metrics: NotificationMetrics): String {
        val snapshots = getWorkerStatusSnapshots()
        val topicSnapshot = snapshots.find { it.worker == WORKER_TOPIC_GENERATION }
        val groupSnapshot = snapshots.find { it.worker == WORKER_GROUP_ITERATION }
        val topicLine =
            buildWorkerDetailsLine(
                label = "Generator",
                snapshot = topicSnapshot,
                nowMs = nowMs,
                doneCount = metrics.topicDoneCount,
                failedCount = metrics.topicFailedCount,
                enabledCount = metrics.topicEnabledCount,
                pendingCount = metrics.topicPendingCount,
                leasedCount = metrics.topicLeasedCount,
            )
        val groupLine =
            buildWorkerDetailsLine(
                label = "Group Chat",
                snapshot = groupSnapshot,
                nowMs = nowMs,
                doneCount = metrics.groupDoneCount,
                failedCount = metrics.groupFailedCount,
                enabledCount = metrics.groupEnabledCount,
                pendingCount = metrics.groupPendingCount,
                leasedCount = metrics.groupLeasedCount,
            )
        val totalsLine =
            "Queue totals: pending=${metrics.totalPendingCount}, leased=${metrics.totalLeasedCount}"
        return listOf(topicLine, groupLine, totalsLine).joinToString("\n")
    }

    private fun formatWorkerSummaryLine(
        label: String,
        snapshot: WorkerStatusSnapshot?,
        nowMs: Long,
        doneCount: Int,
        failedCount: Int,
    ): String {
        if (snapshot == null) return "$label n/a d$doneCount/e$failedCount"
        val ageSec = max(0L, (nowMs - snapshot.heartbeatAtMs) / 1_000L)
        val stale = isWorkerSnapshotStale(snapshot, nowMs)
        val state = formatWorkerState(snapshot, stale)
        return "$label $state ${ageSec}s d$doneCount/e$failedCount"
    }

    private fun buildWorkerDetailsLine(
        label: String,
        snapshot: WorkerStatusSnapshot?,
        nowMs: Long,
        doneCount: Int,
        failedCount: Int,
        enabledCount: Int,
        pendingCount: Int,
        leasedCount: Int,
    ): String {
        if (snapshot == null) {
            return "$label: state=n/a, done=$doneCount, failed=$failedCount, enabled=$enabledCount, " +
                "queue(p=$pendingCount,l=$leasedCount)"
        }
        val ageSec = max(0L, (nowMs - snapshot.heartbeatAtMs) / 1_000L)
        val stale = isWorkerSnapshotStale(snapshot, nowMs)
        val staleTag = if (stale) "stale" else "live"
        val state = formatWorkerState(snapshot, stale)
        val scope = snapshot.scopeId.ifBlank { "-" }
        val detail = snapshot.detail.ifBlank { "-" }
        val error = snapshot.lastError.ifBlank { "-" }
        return "$label: state=$state [$staleTag ${ageSec}s], done=$doneCount, failed=$failedCount, " +
            "enabled=$enabledCount, queue(p=$pendingCount,l=$leasedCount), scope=$scope, detail=$detail, error=$error"
    }

    private fun formatWorkerState(snapshot: WorkerStatusSnapshot, stale: Boolean): String {
        if (stale) return "stale"
        return when (snapshot.state.lowercase()) {
            "running" -> "running"
            "blocked" -> "blocked"
            "error" -> "error"
            "idle" -> "idle"
            else -> snapshot.state
        }
    }

    private fun getNotificationMetrics(nowMs: Long): NotificationMetrics {
        val cached = notificationMetricsCache
        if (cached != null && nowMs - notificationMetricsCacheAtMs <= METRICS_CACHE_TTL_MS) {
            return cached
        }
        val computed = computeNotificationMetrics()
        notificationMetricsCache = computed
        notificationMetricsCacheAtMs = nowMs
        return computed
    }

    private fun computeNotificationMetrics(): NotificationMetrics {
        return try {
            val runtime = BackgroundRuntimeRepository(applicationContext)
            val jobs = BackgroundJobRepository(applicationContext)
            NotificationMetrics(
                topicDoneCount =
                    runtime.countEvents(
                        taskType = WORKER_TOPIC_GENERATION,
                        stage = "iteration_completed",
                    ),
                topicFailedCount =
                    runtime.countEvents(
                        taskType = WORKER_TOPIC_GENERATION,
                        stage = "iteration_failed",
                    ),
                topicEnabledCount =
                    runtime.countDesiredStates(
                        taskType = WORKER_TOPIC_GENERATION,
                        enabledOnly = true,
                    ),
                topicPendingCount =
                    jobs.countJobs(
                        status = BackgroundJobRepository.STATUS_PENDING,
                        type = WORKER_TOPIC_GENERATION,
                    ),
                topicLeasedCount =
                    jobs.countJobs(
                        status = BackgroundJobRepository.STATUS_LEASED,
                        type = WORKER_TOPIC_GENERATION,
                    ),
                groupDoneCount =
                    runtime.countEvents(
                        taskType = WORKER_GROUP_ITERATION,
                        stage = "iteration_completed",
                    ),
                groupFailedCount =
                    runtime.countEvents(
                        taskType = WORKER_GROUP_ITERATION,
                        stage = "iteration_failed",
                    ),
                groupEnabledCount =
                    runtime.countDesiredStates(
                        taskType = WORKER_GROUP_ITERATION,
                        enabledOnly = true,
                    ),
                groupPendingCount =
                    jobs.countJobs(
                        status = BackgroundJobRepository.STATUS_PENDING,
                        type = WORKER_GROUP_ITERATION,
                    ),
                groupLeasedCount =
                    jobs.countJobs(
                        status = BackgroundJobRepository.STATUS_LEASED,
                        type = WORKER_GROUP_ITERATION,
                    ),
            )
        } catch (_: Exception) {
            NotificationMetrics(
                topicDoneCount = 0,
                topicFailedCount = 0,
                topicEnabledCount = 0,
                topicPendingCount = 0,
                topicLeasedCount = 0,
                groupDoneCount = 0,
                groupFailedCount = 0,
                groupEnabledCount = 0,
                groupPendingCount = 0,
                groupLeasedCount = 0,
            )
        }
    }

    private fun shouldPulseWebView(nowMs: Long): Boolean {
        val snapshots = getWorkerStatusSnapshots()
        if (snapshots.isEmpty()) return false
        return snapshots.any { snapshot ->
            val activeState =
                snapshot.state.equals("running", ignoreCase = true) ||
                    snapshot.state.equals("blocked", ignoreCase = true) ||
                    snapshot.state.equals("error", ignoreCase = true)
            activeState || isWorkerSnapshotStale(snapshot, nowMs)
        }
    }
}
