package com.starcore.mobile.music

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.Future

/**
 * Offline music, written only beneath the app's private files/music directory. The
 * session token arrives as a request header and is never written anywhere.
 */
class StarCoreDownloadsModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
    private val executor = Executors.newFixedThreadPool(2)
    private val jobs = ConcurrentHashMap<String, Future<*>>()
    private val root: File by lazy { File(reactApplicationContext.filesDir, "music").canonicalFile }

    override fun getName() = "StarCoreDownloads"

    @ReactMethod
    fun addListener(eventName: String) {
    }

    @ReactMethod
    fun removeListeners(count: Int) {
    }

    private fun resolve(relative: String): File {
        if (relative.isBlank() || relative.contains("..") || relative.startsWith("/") || relative.contains('\\')) {
            throw IllegalArgumentException("invalid path")
        }
        val target = File(root, relative).canonicalFile
        if (!target.path.startsWith(root.path + File.separator)) {
            throw IllegalArgumentException("invalid path")
        }
        return target
    }

    private fun emit(id: String, received: Long, total: Long) {
        val event = Arguments.createMap().apply {
            putString("id", id)
            putDouble("received", received.toDouble())
            putDouble("total", total.toDouble())
        }
        reactApplicationContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("StarCoreDownloadProgress", event)
    }

    @ReactMethod
    fun download(id: String, url: String, headers: ReadableMap, relative: String, promise: Promise) {
        val target = try {
            resolve(relative)
        } catch (error: Exception) {
            promise.reject("E_PATH", "invalid download path")
            return
        }
        if (!url.startsWith("https://") && !url.startsWith("http://")) {
            promise.reject("E_URL", "invalid download url")
            return
        }
        val requestHeaders = headers.toHashMap().mapValues { it.value.toString() }
        jobs[id] = executor.submit {
            val partial = File(target.parentFile, ".${target.name}.part")
            var connection: HttpURLConnection? = null
            try {
                target.parentFile?.mkdirs()
                connection = (URL(url).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 15_000
                    readTimeout = 30_000
                    instanceFollowRedirects = false
                    requestHeaders.forEach { (name, value) -> setRequestProperty(name, value) }
                }
                val status = connection.responseCode
                if (status != 200) {
                    promise.reject("E_HTTP", "the server answered $status")
                    return@submit
                }
                val total = connection.contentLengthLong
                val buffer = ByteArray(64 * 1024)
                var received = 0L
                var lastEmit = 0L
                connection.inputStream.use { input ->
                    partial.outputStream().use { output ->
                        while (true) {
                            if (Thread.currentThread().isInterrupted) throw InterruptedException()
                            val read = input.read(buffer)
                            if (read < 0) break
                            output.write(buffer, 0, read)
                            received += read
                            if (received - lastEmit > 256 * 1024) {
                                emit(id, received, total)
                                lastEmit = received
                            }
                        }
                    }
                }
                if (total > 0 && received != total) throw IllegalStateException("the download was cut short")
                if (target.exists()) target.delete()
                if (!partial.renameTo(target)) throw IllegalStateException("the file could not be saved")
                emit(id, received, total)
                promise.resolve(Arguments.createMap().apply {
                    putString("path", target.path)
                    putDouble("size", received.toDouble())
                })
            } catch (error: InterruptedException) {
                partial.delete()
                promise.reject("E_CANCELLED", "cancelled")
            } catch (error: Exception) {
                partial.delete()
                promise.reject("E_DOWNLOAD", error.message ?: "the download failed")
            } finally {
                connection?.disconnect()
                jobs.remove(id)
            }
        }
    }

    @ReactMethod
    fun cancel(id: String, promise: Promise) {
        promise.resolve(jobs.remove(id)?.cancel(true) ?: false)
    }

    @ReactMethod
    fun remove(relative: String, promise: Promise) {
        try {
            val target = resolve(relative)
            promise.resolve(if (target.isDirectory) target.deleteRecursively() else target.delete())
        } catch (error: Exception) {
            promise.reject("E_PATH", "invalid path")
        }
    }

    @ReactMethod
    fun exists(relative: String, promise: Promise) {
        try {
            val target = resolve(relative)
            promise.resolve(if (target.isFile) target.path else null)
        } catch (error: Exception) {
            promise.resolve(null)
        }
    }

    @ReactMethod
    fun usage(relative: String, promise: Promise) {
        try {
            val target = resolve(relative)
            val used = if (target.exists()) target.walkTopDown().filter { it.isFile }.sumOf { it.length() } else 0L
            promise.resolve(Arguments.createMap().apply {
                putDouble("used", used.toDouble())
                putDouble("free", reactApplicationContext.filesDir.usableSpace.toDouble())
            })
        } catch (error: Exception) {
            promise.reject("E_PATH", "invalid path")
        }
    }

    override fun invalidate() {
        jobs.values.forEach { it.cancel(true) }
        executor.shutdownNow()
        super.invalidate()
    }
}
