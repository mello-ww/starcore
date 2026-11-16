package com.starcore.mobile.sync

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * When the backup runs, all through WorkManager (which keeps its work across reboots): a run
 * when MediaStore's images or videos change, one every six hours, one when the app opens or
 * the person asks, and one when a failed item's backoff is over. Every run has the same constraints, so the system enforces the person's
 * choices: Wi-Fi only unless mobile data is allowed, the charger if they asked for it, never a
 * low battery. No timer loop, no foreground service left running.
 */
object SyncScheduler {
    const val SERVER = "server"
    private const val PERIOD_HOURS = 6L

    private fun name(server: String, what: String) = "starcore.sync.$server.$what"

    private fun constraints(config: SyncConfig): Constraints = Constraints.Builder()
        .setRequiredNetworkType(if (config.mobileData) NetworkType.CONNECTED else NetworkType.UNMETERED)
        .setRequiresCharging(config.charging)
        .setRequiresBatteryNotLow(true)
        .build()

    private fun input(server: String): Data = Data.Builder().putString(SERVER, server).build()

    /** Applies a server's settings: its periodic run and its watch when it is on, nothing when
     * it is off. `changed` replaces a waiting run, so new constraints apply at once. */
    fun apply(context: Context, config: SyncConfig, changed: Boolean) {
        val work = WorkManager.getInstance(context)
        if (!config.enabled) {
            cancel(context, config.server)
            return
        }
        val periodic = PeriodicWorkRequestBuilder<SyncWorker>(PERIOD_HOURS, TimeUnit.HOURS)
            .setConstraints(constraints(config))
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
            .setInputData(input(config.server))
            .build()
        work.enqueueUniquePeriodicWork(name(config.server, "periodic"),
            if (changed) ExistingPeriodicWorkPolicy.UPDATE else ExistingPeriodicWorkPolicy.KEEP, periodic)
        watch(context, config.server)
        runNow(context, config, replace = changed)
    }

    /** A run as soon as the constraints allow. One already running is followed by one more. */
    fun runNow(context: Context, config: SyncConfig, replace: Boolean = false) {
        val work = WorkManager.getInstance(context)
        val name = name(config.server, "now")
        val infos = try { work.getWorkInfosForUniqueWork(name).get() } catch (_: Exception) { emptyList() }
        val running = infos.any { it.state == WorkInfo.State.RUNNING }
        val waiting = infos.any { it.state == WorkInfo.State.ENQUEUED || it.state == WorkInfo.State.BLOCKED }
        val policy = when {
            running && waiting && !replace -> return
            running -> ExistingWorkPolicy.APPEND_OR_REPLACE
            else -> ExistingWorkPolicy.REPLACE
        }
        val request = OneTimeWorkRequestBuilder<SyncWorker>()
            .setConstraints(constraints(config))
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .setInputData(input(config.server))
            .build()
        work.enqueueUniqueWork(name, policy, request)
    }

    /** A run in `delayMillis`, when the soonest failed item's backoff is over, under the same
     * constraints. Replaces the one scheduled before (a later run reschedules it if needed). */
    fun later(context: Context, config: SyncConfig, delayMillis: Long) {
        val request = OneTimeWorkRequestBuilder<SyncWorker>()
            .setConstraints(constraints(config))
            .setInitialDelay(delayMillis, TimeUnit.MILLISECONDS)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .setInputData(input(config.server))
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(name(config.server, "later"), ExistingWorkPolicy.REPLACE, request)
    }

    /** Watches MediaStore's images and videos (a new one starts a run within seconds). */
    fun watch(context: Context, server: String) = enqueueWatch(context, server, ExistingWorkPolicy.KEEP)

    /** From inside the watch itself: the next watch, once this one ends. */
    fun watchAgain(context: Context, server: String) = enqueueWatch(context, server, ExistingWorkPolicy.APPEND_OR_REPLACE)

    private fun enqueueWatch(context: Context, server: String, policy: ExistingWorkPolicy) {
        val constraints = Constraints.Builder().apply {
            MediaScanner.watched().forEach { addContentUriTrigger(it, true) }
            setTriggerContentUpdateDelay(15, TimeUnit.SECONDS)
            setTriggerContentMaxDelay(2, TimeUnit.MINUTES)
        }.build()
        val request = OneTimeWorkRequestBuilder<WatchWorker>()
            .setConstraints(constraints)
            .setInputData(input(server))
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(name(server, "watch"), policy, request)
    }

    /**
     * When the app's process starts: a run for each server whose backup is on if the phone's
     * media changed since its last scan. The watch can miss a change that came while the
     * process was dead (WorkManager may cancel the job that starts the process before it
     * runs), so the change that woke the process is caught here. Off the main thread.
     */
    fun catchUp(context: Context) {
        val app = context.applicationContext
        Thread {
            try {
                val state = MediaScanner.state(app) ?: return@Thread
                val store = SyncStore(app)
                for (server in store.servers()) {
                    val config = store.config(server) ?: continue
                    if (!config.enabled || store.scannedAt(server) == state) continue
                    runNow(app, config)
                }
            } catch (_: Exception) {
                // the watch and the periodic run still follow the change
            }
        }.start()
    }

    /** Whether a run is going on now, or waiting for its constraints. */
    fun activity(context: Context, server: String): Pair<Boolean, Boolean> {
        val work = WorkManager.getInstance(context)
        val infos = listOf("now", "periodic", "later").flatMap {
            try { work.getWorkInfosForUniqueWork(name(server, it)).get() } catch (_: Exception) { emptyList() }
        }
        val running = infos.any { it.state == WorkInfo.State.RUNNING }
        val waiting = try {
            work.getWorkInfosForUniqueWork(name(server, "now")).get()
                .any { it.state == WorkInfo.State.ENQUEUED || it.state == WorkInfo.State.BLOCKED }
        } catch (_: Exception) {
            false
        }
        return running to waiting
    }

    fun cancel(context: Context, server: String) {
        val work = WorkManager.getInstance(context)
        listOf("now", "periodic", "later", "watch").forEach { work.cancelUniqueWork(name(server, it)) }
    }
}
