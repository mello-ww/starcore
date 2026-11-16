package com.starcore.mobile.sync

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File
import java.io.InputStream
import java.security.MessageDigest

/** One image or video on the phone, as MediaStore describes it. */
data class MediaEntry(
    val id: Long,
    val uri: String,
    val kind: String,
    val bucketId: String,
    val bucket: String,
    /** the folder's path on the phone (DCIM/Camera), sent as upload's `folder` */
    val folder: String,
    val name: String,
    val size: Long,
    /** seconds */
    val modified: Long,
    val generation: Long,
    /** when it was taken, Unix seconds */
    val taken: Long?,
)

/** One of the phone's folders (a MediaStore bucket) and how many images and videos it holds. */
data class MediaFolder(val id: String, val name: String, val path: String, val count: Int)

/** How much of the phone's media the app may read. */
enum class MediaAccess(val code: String) { FULL("full"), PARTIAL("partial"), NONE("none") }

/**
 * The phone's images and videos, read from MediaStore: never a path walk, never a write. A
 * file is read whole only to hash it and to send it, as the original when the app may read
 * positions (ACCESS_MEDIA_LOCATION), so the server gets the file as taken.
 */
object MediaScanner {
    private val KINDS = listOf("image", "video")

    fun access(context: Context): MediaAccess {
        fun granted(permission: String) =
            context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
        return when {
            Build.VERSION.SDK_INT >= 33 &&
                granted(Manifest.permission.READ_MEDIA_IMAGES) && granted(Manifest.permission.READ_MEDIA_VIDEO) ->
                MediaAccess.FULL
            Build.VERSION.SDK_INT >= 34 && granted(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) ->
                MediaAccess.PARTIAL
            Build.VERSION.SDK_INT < 33 && granted(Manifest.permission.READ_EXTERNAL_STORAGE) -> MediaAccess.FULL
            else -> MediaAccess.NONE
        }
    }

    /** The collections the backup watches for new media. */
    fun watched(): List<Uri> = listOf(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, MediaStore.Video.Media.EXTERNAL_CONTENT_URI)

    /** Every image and video outside the excluded folders. */
    fun scan(context: Context, excluded: Set<String>): List<MediaEntry> {
        val entries = mutableListOf<MediaEntry>()
        for (kind in KINDS) {
            query(context, kind) { cursor, columns ->
                val bucketId = cursor.getString(columns.bucketId) ?: ""
                if (bucketId in excluded) return@query
                entry(cursor, columns, kind)?.let { entries.add(it) }
            }
        }
        return entries
    }

    /** The phone's folders that hold images or videos, the fullest first. */
    fun folders(context: Context): List<MediaFolder> {
        val folders = LinkedHashMap<String, MediaFolder>()
        for (kind in KINDS) {
            query(context, kind) { cursor, columns ->
                val entry = entry(cursor, columns, kind) ?: return@query
                val known = folders[entry.bucketId]
                folders[entry.bucketId] = known?.copy(count = known.count + 1)
                    ?: MediaFolder(entry.bucketId, entry.bucket.ifEmpty { entry.folder }, entry.folder, 1)
            }
        }
        return folders.values.sortedWith(compareByDescending<MediaFolder> { it.count }.thenBy { it.name.lowercase() })
    }

    /** Opens a media to read: its original (positions kept) when that is allowed. */
    fun open(context: Context, uri: String): InputStream {
        val parsed = Uri.parse(uri)
        if (Build.VERSION.SDK_INT >= 29 &&
            context.checkSelfPermission(Manifest.permission.ACCESS_MEDIA_LOCATION) == PackageManager.PERMISSION_GRANTED) {
            try {
                context.contentResolver.openInputStream(MediaStore.setRequireOriginal(parsed))?.let { return it }
            } catch (_: SecurityException) {
                // the original isn't readable here: the file as MediaStore gives it
            } catch (_: UnsupportedOperationException) {
            }
        }
        return context.contentResolver.openInputStream(parsed) ?: throw java.io.FileNotFoundException(uri)
    }

    /** The SHA-256 of a media's bytes as `open` reads them, in lowercase hex; `stopped` ends it
     * early (null). */
    fun hash(context: Context, uri: String, stopped: () -> Boolean): String? {
        val digest = MessageDigest.getInstance("SHA-256")
        open(context, uri).use { input ->
            val buffer = ByteArray(1 shl 16)
            while (true) {
                if (stopped()) return null
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private class Columns(cursor: Cursor) {
        val id = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
        val bucketId = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.BUCKET_ID)
        val bucket = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.BUCKET_DISPLAY_NAME)
        val name = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME)
        val size = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE)
        val modified = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_MODIFIED)
        val taken = cursor.getColumnIndex(MediaStore.MediaColumns.DATE_TAKEN)
        val relative = if (Build.VERSION.SDK_INT >= 29) cursor.getColumnIndex(MediaStore.MediaColumns.RELATIVE_PATH) else -1
        @Suppress("DEPRECATION")
        val data = if (Build.VERSION.SDK_INT < 29) cursor.getColumnIndex(MediaStore.MediaColumns.DATA) else -1
        val generation = if (Build.VERSION.SDK_INT >= 30) cursor.getColumnIndex(MediaStore.MediaColumns.GENERATION_MODIFIED) else -1
    }

    @Suppress("DEPRECATION")
    private fun query(context: Context, kind: String, each: (Cursor, Columns) -> Unit) {
        val collection = if (kind == "image") MediaStore.Images.Media.EXTERNAL_CONTENT_URI
            else MediaStore.Video.Media.EXTERNAL_CONTENT_URI
        val projection = mutableListOf(
            MediaStore.MediaColumns._ID, MediaStore.MediaColumns.BUCKET_ID, MediaStore.MediaColumns.BUCKET_DISPLAY_NAME,
            MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.DATE_MODIFIED,
            MediaStore.MediaColumns.DATE_TAKEN,
        )
        if (Build.VERSION.SDK_INT >= 29) projection.add(MediaStore.MediaColumns.RELATIVE_PATH) else projection.add(MediaStore.MediaColumns.DATA)
        if (Build.VERSION.SDK_INT >= 30) projection.add(MediaStore.MediaColumns.GENERATION_MODIFIED)
        // a file still being written (IS_PENDING) is left for the next run
        val selection = if (Build.VERSION.SDK_INT >= 29) "${MediaStore.MediaColumns.IS_PENDING} = 0" else null
        context.contentResolver.query(collection, projection.toTypedArray(), selection, null, null)?.use { cursor ->
            val columns = Columns(cursor)
            while (cursor.moveToNext()) each(cursor, columns)
        }
    }

    private fun entry(cursor: Cursor, columns: Columns, kind: String): MediaEntry? {
        val id = cursor.getLong(columns.id)
        val size = cursor.getLong(columns.size)
        if (size <= 0) return null
        val collection = if (kind == "image") MediaStore.Images.Media.EXTERNAL_CONTENT_URI
            else MediaStore.Video.Media.EXTERNAL_CONTENT_URI
        val folder = when {
            columns.relative >= 0 -> (cursor.getString(columns.relative) ?: "").trim('/')
            columns.data >= 0 -> legacyFolder(cursor.getString(columns.data))
            else -> ""
        }
        val takenMillis = if (columns.taken >= 0 && !cursor.isNull(columns.taken)) cursor.getLong(columns.taken) else 0L
        return MediaEntry(
            id = id,
            uri = ContentUris.withAppendedId(collection, id).toString(),
            kind = kind,
            bucketId = cursor.getString(columns.bucketId) ?: "",
            bucket = cursor.getString(columns.bucket) ?: "",
            folder = folder,
            name = cursor.getString(columns.name) ?: "$id",
            size = size,
            modified = cursor.getLong(columns.modified),
            generation = if (columns.generation >= 0) cursor.getLong(columns.generation) else 0L,
            taken = if (takenMillis > 0) takenMillis / 1000 else null,
        )
    }

    @Suppress("DEPRECATION")
    private fun legacyFolder(path: String?): String {
        val parent = path?.let { File(it).parent } ?: return ""
        val root = Environment.getExternalStorageDirectory().absolutePath
        return if (parent.startsWith(root)) parent.removePrefix(root).trim('/') else File(parent).name
    }
}
