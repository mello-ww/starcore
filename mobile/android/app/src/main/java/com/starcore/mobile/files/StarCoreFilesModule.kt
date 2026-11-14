package com.starcore.mobile.files

import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * The download and share actions of the shared interface (UI contract 1.2): one file from a
 * Satellite's own route, fetched with the session token as a request header (never written
 * anywhere), then saved to Downloads (Android 10 and later, no storage permission needed),
 * opened in the phone's own viewer (a download with `open`) or handed to the system share
 * sheet. A shared or opened file is written only beneath the app's private cache/shared or
 * cache/opened directory, which the FileProvider exposes read-only to the app chosen, and
 * replaced by the next one. Nothing here knows a Satellite.
 */
class StarCoreFilesModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
    private val executor = Executors.newSingleThreadExecutor()
    private val sharedDir: File by lazy { File(reactApplicationContext.cacheDir, "shared") }
    private val openedDir: File by lazy { File(reactApplicationContext.cacheDir, "opened") }

    override fun getName() = "StarCoreFiles"

    override fun getConstants(): Map<String, Any> = mapOf(
        // MediaStore.Downloads arrived in Android 10; before it, saving needs a storage permission
        "canSave" to (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q),
        "canShare" to true,
        "canOpen" to true,
    )

    private fun safeName(name: String): String {
        val cleaned = name.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), "_").trimStart('.').take(120)
        return cleaned.ifBlank { "download" }
    }

    /** Opens the URL with the given headers; the caller reads it and disconnects it. */
    private fun connect(url: String, headers: ReadableMap): HttpURLConnection {
        if (!url.startsWith("https://") && !url.startsWith("http://")) {
            throw IllegalArgumentException("invalid url")
        }
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 30_000
            instanceFollowRedirects = false
            headers.toHashMap().forEach { (name, value) -> setRequestProperty(name, value.toString()) }
        }
        val status = connection.responseCode
        if (status != 200) {
            connection.disconnect()
            throw IllegalStateException("the server answered $status")
        }
        return connection
    }

    private fun mimeOf(connection: HttpURLConnection): String =
        connection.contentType?.substringBefore(';')?.trim()?.takeIf { it.contains('/') } ?: "application/octet-stream"

    /** The server's type, else one guessed from the name's extension, so a viewer is found for
     * a file the server sends as plain bytes. */
    private fun viewMimeOf(connection: HttpURLConnection, name: String): String {
        val sent = mimeOf(connection)
        if (sent != "application/octet-stream") return sent
        val extension = name.substringAfterLast('.', "").lowercase()
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension) ?: sent
    }

    /** Fetches the file into `dir`, emptied first, so only the latest one lives there. */
    private fun fetchInto(dir: File, connection: HttpURLConnection, name: String): File {
        dir.deleteRecursively()
        dir.mkdirs()
        val file = File(dir, safeName(name))
        connection.inputStream.use { input ->
            file.outputStream().use { output -> copy(input, output, connection.contentLengthLong) }
        }
        return file
    }

    private fun copy(input: InputStream, output: OutputStream, expected: Long) {
        val buffer = ByteArray(64 * 1024)
        var received = 0L
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            output.write(buffer, 0, read)
            received += read
        }
        if (expected > 0 && received != expected) throw IllegalStateException("the download was cut short")
    }

    @ReactMethod
    fun save(url: String, headers: ReadableMap, name: String, promise: Promise) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            promise.reject("E_UNSUPPORTED", "saving needs Android 10 or later")
            return
        }
        executor.execute {
            val resolver = reactApplicationContext.contentResolver
            var connection: HttpURLConnection? = null
            var target: android.net.Uri? = null
            try {
                connection = connect(url, headers)
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, safeName(name))
                    put(MediaStore.MediaColumns.MIME_TYPE, mimeOf(connection))
                    put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }
                target = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: throw IllegalStateException("the file could not be created")
                connection.inputStream.use { input ->
                    (resolver.openOutputStream(target) ?: throw IllegalStateException("the file could not be written"))
                        .use { output -> copy(input, output, connection.contentLengthLong) }
                }
                resolver.update(target, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
                promise.resolve(Arguments.createMap().apply { putString("name", safeName(name)) })
            } catch (error: Exception) {
                target?.let { runCatching { resolver.delete(it, null, null) } }
                promise.reject("E_SAVE", error.message ?: "the file could not be saved")
            } finally {
                connection?.disconnect()
            }
        }
    }

    @ReactMethod
    fun share(url: String, headers: ReadableMap, name: String, promise: Promise) {
        executor.execute {
            var connection: HttpURLConnection? = null
            try {
                connection = connect(url, headers)
                val mime = mimeOf(connection)
                // only the file being shared lives here: the previous one goes first
                val file = fetchInto(sharedDir, connection, name)
                val context = reactApplicationContext
                val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
                val send = Intent(Intent.ACTION_SEND).apply {
                    type = mime
                    putExtra(Intent.EXTRA_STREAM, uri)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                val chooser = Intent.createChooser(send, null).apply { addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION) }
                val activity = currentActivity
                if (activity != null) {
                    activity.runOnUiThread { activity.startActivity(chooser) }
                } else {
                    context.startActivity(chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
                promise.resolve(true)
            } catch (error: Exception) {
                promise.reject("E_SHARE", error.message ?: "the file could not be shared")
            } finally {
                connection?.disconnect()
            }
        }
    }

    @ReactMethod
    fun open(url: String, headers: ReadableMap, name: String, promise: Promise) {
        executor.execute {
            var connection: HttpURLConnection? = null
            try {
                connection = connect(url, headers)
                val mime = viewMimeOf(connection, name)
                // only the file being opened lives here: the previous one goes first
                val file = fetchInto(openedDir, connection, name)
                val context = reactApplicationContext
                val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
                val view = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(uri, mime)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                val start = Runnable {
                    try {
                        val activity = currentActivity
                        if (activity != null) {
                            activity.startActivity(view)
                        } else {
                            context.startActivity(view.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                        }
                        promise.resolve(true)
                    } catch (error: ActivityNotFoundException) {
                        promise.reject("E_NO_VIEWER", "No app on this phone opens this kind of file.")
                    } catch (error: Exception) {
                        promise.reject("E_OPEN", error.message ?: "the file could not be opened")
                    }
                }
                currentActivity?.runOnUiThread(start) ?: start.run()
            } catch (error: Exception) {
                promise.reject("E_OPEN", error.message ?: "the file could not be opened")
            } finally {
                connection?.disconnect()
            }
        }
    }

    override fun invalidate() {
        executor.shutdownNow()
        super.invalidate()
    }
}
