package com.starcore.mobile.sync

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.ViewManager
import java.util.concurrent.Executors

/**
 * The app's background backup of the phone's media (client capability device.media-sync), for
 * the sync screen (src/sync/). The screen finds a media.sync provider in the server's catalog,
 * asks for a device credential and hands both here; from then on the backup runs without the
 * app (SyncScheduler, SyncWorker). Nothing here knows a Satellite: the provider's name and
 * operation routes come from the catalog.
 */
class StarCoreSyncModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
    private val executor = Executors.newSingleThreadExecutor()
    private val store by lazy { SyncStore(reactApplicationContext) }

    override fun getName() = "StarCoreSync"

    override fun getConstants(): Map<String, Any> = mapOf(
        // what the phone calls itself in the server's list of devices
        "deviceName" to listOf(Build.MANUFACTURER, Build.MODEL)
            .filter { !it.isNullOrBlank() }
            .distinctBy { it.lowercase() }
            .joinToString(" ") { part -> part.replaceFirstChar { it.uppercase() } }
            .ifBlank { "Android phone" },
        "sdk" to Build.VERSION.SDK_INT,
    )

    private fun background(promise: Promise, work: () -> Any?) {
        executor.execute {
            try {
                promise.resolve(work())
            } catch (error: Exception) {
                promise.reject("sync", error.message ?: "the backup failed", error)
            }
        }
    }

    /** Sets up (or replaces) a server's backup and turns it on: {origin, satellite, routes:
     * {status, check, upload}, device, token, sessionId}. Keeps the person's earlier choices. */
    @ReactMethod
    fun configure(server: String, options: ReadableMap, promise: Promise) = background(promise) {
        val origin = SyncRules.origin(options.getString("origin") ?: "")
            ?: throw IllegalArgumentException("the server's address must be http or https, with nothing after the host")
        val satellite = options.getString("satellite") ?: ""
        val routes = options.getMap("routes") ?: throw IllegalArgumentException("routes are missing")
        val status = routes.getString("status") ?: ""
        val check = routes.getString("check") ?: ""
        val upload = routes.getString("upload") ?: ""
        if (!listOf(status, check, upload).all { SyncRules.validRoute(satellite, it) }) {
            throw IllegalArgumentException("the provider's operations are invalid")
        }
        val token = options.getString("token")?.takeIf { it.isNotBlank() }
            ?: throw IllegalArgumentException("the credential is missing")
        val earlier = store.config(server)
        val config = SyncConfig(
            server = server, origin = origin, satellite = satellite,
            statusRoute = status, checkRoute = check, uploadRoute = upload,
            device = (options.getString("device") ?: "").take(80),
            sessionId = if (options.hasKey("sessionId")) options.getString("sessionId") else null,
            enabled = true,
            mobileData = earlier?.mobileData ?: false,
            charging = earlier?.charging ?: false,
            excluded = earlier?.excluded ?: emptySet(),
        )
        store.saveToken(server, token)
        store.save(config)
        store.saveRun(server, Phases.IDLE)
        SyncScheduler.apply(reactApplicationContext, config, changed = true)
        state(server)
    }

    /** Changes the person's choices: any of {enabled, mobileData, charging, excluded}. */
    @ReactMethod
    fun update(server: String, changes: ReadableMap, promise: Promise) = background(promise) {
        val earlier = store.config(server) ?: throw IllegalStateException("this server has no backup")
        val excluded = if (changes.hasKey("excluded")) {
            val list = changes.getArray("excluded")
            (0 until (list?.size() ?: 0)).mapNotNull { list!!.getString(it) }.toSet()
        } else {
            earlier.excluded
        }
        val config = earlier.copy(
            enabled = if (changes.hasKey("enabled")) changes.getBoolean("enabled") else earlier.enabled,
            mobileData = if (changes.hasKey("mobileData")) changes.getBoolean("mobileData") else earlier.mobileData,
            charging = if (changes.hasKey("charging")) changes.getBoolean("charging") else earlier.charging,
            excluded = excluded,
        )
        store.save(config)
        SyncScheduler.apply(reactApplicationContext, config, changed = true)
        state(server)
    }

    /** Everything the screen shows: the settings, the last run, the index's counts, and what a
     * waiting run waits for (network, charger, battery, permission). */
    @ReactMethod
    fun state(server: String, promise: Promise) = background(promise) { state(server) }

    private fun state(server: String): WritableMap {
        val context = reactApplicationContext
        val map = Arguments.createMap()
        val config = store.config(server)
        map.putBoolean("configured", config != null)
        map.putString("access", MediaScanner.access(context).code)
        map.putString("network", network(context))
        val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val plugged = (battery?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0
        map.putBoolean("plugged", plugged)
        map.putBoolean("batteryLow", !plugged && level >= 0 && scale > 0 && level * 100 / scale <= 15)
        if (config == null) return map
        map.putBoolean("enabled", config.enabled)
        map.putBoolean("mobileData", config.mobileData)
        map.putBoolean("charging", config.charging)
        map.putArray("excluded", Arguments.createArray().apply { config.excluded.sorted().forEach { pushString(it) } })
        map.putString("origin", config.origin)
        map.putBoolean("credential", store.token(server) != null)
        val run = store.run(server)
        map.putString("phase", run.phase)
        map.putInt("done", run.done)
        map.putInt("total", run.total)
        map.putDouble("lastRun", run.lastRun.toDouble())
        map.putDouble("updated", run.updated.toDouble())
        val (running, waiting) = SyncScheduler.activity(context, server)
        map.putBoolean("running", running)
        map.putBoolean("waiting", waiting)
        val counts = SyncIndex(context, server).use { it.counts() }
        map.putInt("backedUp", counts[ItemState.DONE] ?: 0)
        map.putInt("pending", (counts[ItemState.PENDING] ?: 0) + (counts[ItemState.UPLOADING] ?: 0))
        map.putInt("failed", counts[ItemState.FAILED] ?: 0)
        return map
    }

    /** The phone's folders that hold images or videos: [{id, name, path, count}]. */
    @ReactMethod
    fun folders(promise: Promise) = background(promise) {
        val list = Arguments.createArray()
        if (MediaScanner.access(reactApplicationContext) == MediaAccess.FULL) {
            MediaScanner.folders(reactApplicationContext).forEach { folder ->
                list.pushMap(Arguments.createMap().apply {
                    putString("id", folder.id); putString("name", folder.name)
                    putString("path", folder.path); putInt("count", folder.count)
                })
            }
        }
        list
    }

    /** The failed items, newest first: [{id, name, folder, reason}]. */
    @ReactMethod
    fun failures(server: String, promise: Promise) = background(promise) {
        val list = Arguments.createArray()
        SyncIndex(reactApplicationContext, server).use { index ->
            index.failed(100).forEach { item ->
                list.pushMap(Arguments.createMap().apply {
                    putString("id", item.id.toString()); putString("name", item.name)
                    putString("folder", item.bucket.ifEmpty { item.folder }); putString("reason", item.reason ?: Reasons.REFUSED)
                })
            }
        }
        list
    }

    /** "Try again": every failed item is pending again, and a run is queued. */
    @ReactMethod
    fun retry(server: String, promise: Promise) = background(promise) {
        SyncIndex(reactApplicationContext, server).use { it.retryAll() }
        store.config(server)?.takeIf { it.enabled }?.let { SyncScheduler.runNow(reactApplicationContext, it) }
        state(server)
    }

    /** "Back up now", and the run when the app opens: under the same constraints. */
    @ReactMethod
    fun runNow(server: String, promise: Promise) = background(promise) {
        store.config(server)?.takeIf { it.enabled }?.let {
            SyncScheduler.apply(reactApplicationContext, it, changed = false)
        }
        state(server)
    }

    /** Removes everything kept for a server's backup (signing out): its work, settings,
     * credential and index. Resolves with the credential's session id, for the app to revoke. */
    @ReactMethod
    fun forget(server: String, promise: Promise) = background(promise) {
        val sessionId = store.config(server)?.sessionId
        SyncScheduler.cancel(reactApplicationContext, server)
        store.forget(server)
        SyncIndex.delete(reactApplicationContext, server)
        sessionId
    }

    private fun network(context: Context): String {
        val manager = context.getSystemService(ConnectivityManager::class.java) ?: return "unknown"
        val capabilities = manager.getNetworkCapabilities(manager.activeNetwork) ?: return "none"
        if (!capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) return "none"
        return if (capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)) "unmetered" else "metered"
    }
}

class SyncPackage : ReactPackage {
    override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> =
        listOf(StarCoreSyncModule(context))

    override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
