package com.starcore.mobile.sync

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.ForegroundInfo
import androidx.work.Worker
import androidx.work.WorkerParameters

/**
 * A backup run, scheduled by SyncScheduler under WorkManager's constraints (the network the
 * person allows, the charger if they asked for it, never a low battery). Once there is
 * something to send it becomes a dataSync foreground job with a progress notification; if the
 * system refuses that from the background, it goes on without one. Stopped by the system, it
 * is rescheduled with backoff and resumes where it was.
 */
class SyncWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val server = inputData.getString(SyncScheduler.SERVER) ?: return Result.success()
        val store = SyncStore(applicationContext)
        val config = store.config(server) ?: return Result.success()
        if (!config.enabled) return Result.success()
        // a new image or video starts the next run
        SyncScheduler.watch(applicationContext, server)
        var foreground = false
        val run = SyncRun(applicationContext, store, config, { isStopped }) { done, total ->
            if (total == 0) return@SyncRun
            val notification = SyncNotifications.progress(applicationContext, done, total)
            if (!foreground) {
                foreground = try {
                    setForegroundAsync(foregroundInfo(notification)).get()
                    true
                } catch (_: Exception) {
                    false
                }
            }
            if (foreground) {
                SyncNotifications.show(applicationContext, notification)
            }
        }
        val retry = run.run()
        // an item left to retry after its backoff gets a run of its own then, not at the next
        // periodic one
        if (!isStopped) run.later?.let { SyncScheduler.later(applicationContext, config, it) }
        return if (retry) Result.retry() else Result.success()
    }

    override fun getForegroundInfo(): ForegroundInfo =
        foregroundInfo(SyncNotifications.progress(applicationContext, 0, 0))

    private fun foregroundInfo(notification: Notification): ForegroundInfo =
        if (Build.VERSION.SDK_INT >= 29) {
            ForegroundInfo(SyncNotifications.ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            ForegroundInfo(SyncNotifications.ID, notification)
        }
}

/** Fires when MediaStore's images or videos change: queues a run, and watches again. */
class WatchWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val server = inputData.getString(SyncScheduler.SERVER) ?: return Result.success()
        val config = SyncStore(applicationContext).config(server) ?: return Result.success()
        if (!config.enabled) return Result.success()
        SyncScheduler.runNow(applicationContext, config)
        SyncScheduler.watchAgain(applicationContext, server)
        return Result.success()
    }
}

/** The backup's one notification: its progress while a run sends. */
object SyncNotifications {
    const val ID = 0x5C0C
    private const val CHANNEL = "starcore.sync"

    fun progress(context: Context, done: Int, total: Int): Notification {
        channel(context)
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
        val open = launch?.let {
            PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
        val builder = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle("Backing up this phone")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        if (open != null) builder.setContentIntent(open)
        if (total > 0) {
            builder.setContentText("$done of $total sent").setProgress(total, done, false)
        } else {
            builder.setContentText("Looking for new media").setProgress(0, 0, true)
        }
        return builder.build()
    }

    fun show(context: Context, notification: Notification) {
        try {
            NotificationManagerCompat.from(context).notify(ID, notification)
        } catch (_: SecurityException) {
            // notifications aren't allowed: the run goes on without them
        }
    }

    private fun channel(context: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL) != null) return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, "Backup", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Progress while this phone backs up its media"
                setShowBadge(false)
            },
        )
    }
}
