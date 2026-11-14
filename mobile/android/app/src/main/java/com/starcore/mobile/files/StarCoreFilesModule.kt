package com.starcore.mobile.files

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import com.facebook.react.bridge.ActivityEventListener
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
 * The download, share and upload actions of the shared interface (UI contract 1.2): one file
 * from a Satellite's own route, fetched with the session token as a request header (never
 * written anywhere), then saved to Downloads (Android 10 and later, no storage permission
 * needed), opened in the phone's own viewer (a download with `open`) or handed to the system
 * share sheet. A shared or opened file is written only beneath the app's private cache/shared or
 * cache/opened directory, which the FileProvider exposes read-only to the app chosen, and
 * replaced by the next one. An upload picks documents with the system picker (no storage
 * permission: only what the person chose is readable) and streams each as the raw body of a
 * POST, with the session header. Nothing here knows a Satellite.
 */
class StarCoreFilesModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context), ActivityEventListener {
    private val executor = Executors.newSingleThreadExecutor()
    private val sharedDir: File by lazy { File(reactApplicationContext.cacheDir, "shared") }
    private val openedDir: File by lazy { File(reactApplicationContext.cacheDir, "opened") }
    private val uploadingDir: File by lazy { File(reactApplicationContext.cacheDir, "uploading") }
    // the picker's answer arrives in onActivityResult, for the call that opened it
    private var picking: Promise? = null

    init {
        context.addActivityEventListener(this)
    }

    override fun getName() = "StarCoreFiles"

    override fun getConstants(): Map<String, Any> = mapOf(
        // MediaStore.Downloads arrived in Android 10; before it, saving needs a storage permission
        "canSave" to (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q),
        "canShare" to true,
        "canOpen" to true,
        // the system document picker needs no permission on any Android the app runs on
        "canUpload" to true,
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

    /** The system document picker: resolves [{uri, name, size}] for what was chosen, or an empty
     * list when the picker was closed. `size` is -1 where the document's provider doesn't say. */
    @ReactMethod
    fun pick(multiple: Boolean, promise: Promise) {
        val activity = currentActivity
        if (activity == null) {
            promise.reject("E_PICK", "the app is not in the foreground")
            return
        }
        if (picking != null) {
            promise.reject("E_PICK", "files are already being chosen")
            return
        }
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple)
        }
        picking = promise
        try {
            activity.startActivityForResult(intent, PICK_REQUEST)
        } catch (error: ActivityNotFoundException) {
            picking = null
            promise.reject("E_PICK", "No app on this phone lets you choose files.")
        }
    }

    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != PICK_REQUEST) return
        val promise = picking ?: return
        picking = null
        val chosen = Arguments.createArray()
        if (resultCode == Activity.RESULT_OK && data != null) {
            val uris = mutableListOf<Uri>()
            val clip = data.clipData
            if (clip != null) {
                for (index in 0 until clip.itemCount) clip.getItemAt(index).uri?.let { uris.add(it) }
            } else {
                data.data?.let { uris.add(it) }
            }
            try {
                for (uri in uris) {
                    val (name, size) = describe(uri)
                    chosen.pushMap(Arguments.createMap().apply {
                        putString("uri", uri.toString())
                        putString("name", name)
                        putDouble("size", size.toDouble())
                    })
                }
            } catch (error: Exception) {
                promise.reject("E_PICK", error.message ?: "the chosen files could not be read")
                return
            }
        }
        promise.resolve(chosen)
    }

    override fun onNewIntent(intent: Intent) {}

    /** A chosen document's display name and size (-1 when its provider doesn't say). */
    private fun describe(uri: Uri): Pair<String, Long> {
        var name = ""
        var size = -1L
        reactApplicationContext.contentResolver
            .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)
            ?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val nameAt = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    val sizeAt = cursor.getColumnIndex(OpenableColumns.SIZE)
                    if (nameAt >= 0 && !cursor.isNull(nameAt)) name = cursor.getString(nameAt) ?: ""
                    if (sizeAt >= 0 && !cursor.isNull(sizeAt)) size = cursor.getLong(sizeAt)
                }
            }
        return Pair(name.ifBlank { uri.lastPathSegment?.substringAfterLast('/') ?: "" }, size)
    }

    /** Streams one chosen document as the raw body of a POST to `url`, with the given headers and
     * its length declared. Resolves {status, body} for whatever the server answered; rejects only
     * when no answer came back. A document whose provider doesn't give its size is copied into
     * the app's private cache/uploading first, to know it, and removed after. */
    @ReactMethod
    fun upload(document: String, url: String, headers: ReadableMap, promise: Promise) {
        executor.execute {
            var connection: HttpURLConnection? = null
            var copied: File? = null
            try {
                if (!url.startsWith("https://") && !url.startsWith("http://")) {
                    throw IllegalArgumentException("invalid url")
                }
                val uri = Uri.parse(document)
                val resolver = reactApplicationContext.contentResolver
                var length = describe(uri).second
                if (length < 0) {
                    uploadingDir.deleteRecursively()
                    uploadingDir.mkdirs()
                    val file = File(uploadingDir, "upload")
                    (resolver.openInputStream(uri) ?: throw IllegalStateException("the file could not be read")).use { input ->
                        file.outputStream().use { output -> copy(input, output, -1) }
                    }
                    copied = file
                    length = file.length()
                }
                val open = (URL(url).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 15_000
                    readTimeout = 120_000
                    instanceFollowRedirects = false
                    requestMethod = "POST"
                    doOutput = true
                    setFixedLengthStreamingMode(length)
                    headers.toHashMap().forEach { (name, value) -> setRequestProperty(name, value.toString()) }
                    // plain bytes whatever the file is, so the route never takes it for JSON
                    setRequestProperty("Content-Type", "application/octet-stream")
                    setRequestProperty("Accept", "application/json")
                }
                connection = open
                val source = copied?.inputStream() ?: resolver.openInputStream(uri)
                    ?: throw IllegalStateException("the file could not be read")
                source.use { input -> open.outputStream.use { output -> sendExactly(input, output, length) } }
                val status = open.responseCode
                val stream = if (status >= 400) open.errorStream else open.inputStream
                val body = stream?.use { String(readAtMost(it, 64 * 1024), Charsets.UTF_8) } ?: ""
                promise.resolve(Arguments.createMap().apply {
                    putInt("status", status)
                    putString("body", body)
                })
            } catch (error: Exception) {
                promise.reject("E_UPLOAD", error.message ?: "the file could not be uploaded")
            } finally {
                connection?.disconnect()
                copied?.delete()
            }
        }
    }

    /** Sends exactly `length` bytes: a document that changed size since it was described fails
     * here rather than sending a body that doesn't match its declared length. */
    private fun sendExactly(input: InputStream, output: OutputStream, length: Long) {
        val buffer = ByteArray(64 * 1024)
        var sent = 0L
        while (sent < length) {
            val read = input.read(buffer, 0, minOf(buffer.size.toLong(), length - sent).toInt())
            if (read < 0) throw IllegalStateException("the file ended before its size")
            output.write(buffer, 0, read)
            sent += read
        }
    }

    private fun readAtMost(input: InputStream, limit: Int): ByteArray {
        val buffer = ByteArray(limit)
        var total = 0
        while (total < limit) {
            val read = input.read(buffer, total, limit - total)
            if (read < 0) break
            total += read
        }
        return buffer.copyOf(total)
    }

    override fun invalidate() {
        picking?.reject("E_PICK", "the app closed")
        picking = null
        reactApplicationContext.removeActivityEventListener(this)
        executor.shutdownNow()
        super.invalidate()
    }

    companion object {
        private const val PICK_REQUEST = 4710
    }
}
