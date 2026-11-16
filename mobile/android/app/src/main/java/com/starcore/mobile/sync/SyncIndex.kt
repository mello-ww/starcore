package com.starcore.mobile.sync

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import java.io.Closeable

/** One indexed media, as the run needs it. */
data class IndexedItem(
    val id: Long,
    val uri: String,
    val kind: String,
    val folder: String,
    val bucket: String,
    val name: String,
    val size: Long,
    val taken: Long?,
    val sha256: String?,
    val state: ItemState,
    val offset: Long,
    val attempts: Int,
    val reason: String?,
)

/**
 * The local index, one SQLite database per server in the app's private storage: each media of
 * the chosen folders by its MediaStore id, the version it was indexed at, its SHA-256 once
 * hashed, and its state (pending, uploading with an offset, done, failed with a reason, its
 * attempts and when it may be retried). Items fail one by one: a failure never blocks the others.
 */
class SyncIndex(context: Context, server: String) : Closeable {
    private val helper = Helper(context, fileName(server))
    private val db: SQLiteDatabase get() = helper.writableDatabase

    /** Brings the index in line with a scan (SyncRules.reconcile). */
    fun reconcile(scanned: List<MediaEntry>) {
        val indexed = HashMap<Long, Version>()
        db.rawQuery("SELECT id, size, modified, generation FROM items", null).use { cursor ->
            while (cursor.moveToNext()) {
                val id = cursor.getLong(0)
                indexed[id] = Version(id, cursor.getLong(1), cursor.getLong(2), cursor.getLong(3))
            }
        }
        val byId = scanned.associateBy { it.id }
        val plan = SyncRules.reconcile(indexed, scanned.map { Version(it.id, it.size, it.modified, it.generation) })
        db.beginTransaction()
        try {
            for (id in plan.added) {
                db.insert(TABLE, null, values(byId.getValue(id)).apply { put("id", id); put("state", ItemState.PENDING.code) })
            }
            for (id in plan.changed) {
                db.update(TABLE, values(byId.getValue(id)).apply { putNull("sha256"); reset(this) }, "id = ?", arrayOf("$id"))
            }
            for (id in plan.removed) {
                db.delete(TABLE, "id = ?", arrayOf("$id"))
            }
            // names, folders and dates may change without the content changing
            val written = (plan.added + plan.changed).toHashSet()
            for (entry in scanned) {
                if (entry.id in written) continue
                db.update(TABLE, ContentValues().apply {
                    put("uri", entry.uri); put("folder", entry.folder); put("bucket", entry.bucket); put("name", entry.name)
                    if (entry.taken != null) put("taken", entry.taken) else putNull("taken")
                }, "id = ?", arrayOf("${entry.id}"))
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    /** Failed items whose backoff is over go back to pending. */
    fun releaseDue(now: Long) {
        db.update(TABLE, ContentValues().apply { put("state", ItemState.PENDING.code); putNull("reason") },
            "state = ? AND next_try <= ?", arrayOf(ItemState.FAILED.code, "$now"))
    }

    /** "Try again": every failed item is pending again, its attempts forgotten. */
    fun retryAll() {
        db.update(TABLE, ContentValues().apply { reset(this) }, "state = ?", arrayOf(ItemState.FAILED.code))
    }

    /** Pending or interrupted items, newest first: not hashed yet when `hashed` is false. */
    fun toSend(hashed: Boolean): List<IndexedItem> {
        val digest = if (hashed) "sha256 IS NOT NULL" else "sha256 IS NULL"
        return query("state IN (?, ?) AND $digest", arrayOf(ItemState.PENDING.code, ItemState.UPLOADING.code))
    }

    fun item(id: Long): IndexedItem? = query("id = ?", arrayOf("$id")).firstOrNull()

    fun setHash(id: Long, sha256: String) = update(id, ContentValues().apply { put("sha256", sha256) })

    fun setOffset(id: Long, offset: Long) =
        update(id, ContentValues().apply { put("state", ItemState.UPLOADING.code); put("position", offset) })

    fun markDone(id: Long) = update(id, ContentValues().apply {
        put("state", ItemState.DONE.code); put("position", 0); putNull("reason"); put("attempts", 0); put("next_try", 0)
    })

    /** The file must be hashed again (it changed while it was sent); counts as an attempt. */
    fun restart(id: Long, attempts: Int, nextTry: Long) = update(id, ContentValues().apply {
        putNull("sha256"); put("position", 0); put("attempts", attempts); put("next_try", nextTry)
        put("state", if (attempts >= SyncRules.MAX_ATTEMPTS) ItemState.FAILED.code else ItemState.PENDING.code)
        if (attempts >= SyncRules.MAX_ATTEMPTS) put("reason", Reasons.CHANGING) else putNull("reason")
    })

    fun markFailed(id: Long, reason: String, attempts: Int, nextTry: Long) = update(id, ContentValues().apply {
        put("state", ItemState.FAILED.code); put("reason", reason); put("attempts", attempts); put("next_try", nextTry)
    })

    /** How many items are in each state. */
    fun counts(): Map<ItemState, Int> {
        val counts = HashMap<ItemState, Int>()
        db.rawQuery("SELECT state, COUNT(*) FROM items GROUP BY state", null).use { cursor ->
            while (cursor.moveToNext()) {
                val state = ItemState.of(cursor.getString(0))
                counts[state] = (counts[state] ?: 0) + cursor.getInt(1)
            }
        }
        return counts
    }

    fun failed(limit: Int): List<IndexedItem> =
        query("state = ?", arrayOf(ItemState.FAILED.code), limit)

    override fun close() = helper.close()

    private fun update(id: Long, values: ContentValues) {
        db.update(TABLE, values, "id = ?", arrayOf("$id"))
    }

    private fun reset(values: ContentValues) {
        values.put("state", ItemState.PENDING.code)
        values.put("position", 0)
        values.putNull("reason")
        values.put("attempts", 0)
        values.put("next_try", 0)
    }

    private fun values(entry: MediaEntry) = ContentValues().apply {
        put("uri", entry.uri); put("kind", entry.kind); put("folder", entry.folder); put("bucket", entry.bucket)
        put("name", entry.name); put("size", entry.size); put("modified", entry.modified)
        put("generation", entry.generation)
        if (entry.taken != null) put("taken", entry.taken) else putNull("taken")
    }

    private fun query(where: String, args: Array<String>, limit: Int? = null): List<IndexedItem> {
        val items = mutableListOf<IndexedItem>()
        db.query(TABLE, COLUMNS, where, args, null, null, "COALESCE(taken, modified * 1000) DESC, id DESC",
            limit?.toString()).use { cursor ->
            while (cursor.moveToNext()) {
                items.add(IndexedItem(
                    id = cursor.getLong(0), uri = cursor.getString(1), kind = cursor.getString(2),
                    folder = cursor.getString(3) ?: "", bucket = cursor.getString(4) ?: "",
                    name = cursor.getString(5) ?: "", size = cursor.getLong(6),
                    taken = if (cursor.isNull(7)) null else cursor.getLong(7),
                    sha256 = cursor.getString(8), state = ItemState.of(cursor.getString(9)),
                    offset = cursor.getLong(10), attempts = cursor.getInt(11), reason = cursor.getString(12),
                ))
            }
        }
        return items
    }

    private class Helper(context: Context, name: String) : SQLiteOpenHelper(context, name, null, 1) {
        override fun onCreate(db: SQLiteDatabase) {
            db.execSQL("""
                CREATE TABLE items (
                    id INTEGER PRIMARY KEY,
                    uri TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    folder TEXT,
                    bucket TEXT,
                    name TEXT,
                    size INTEGER NOT NULL,
                    modified INTEGER NOT NULL,
                    generation INTEGER NOT NULL DEFAULT 0,
                    taken INTEGER,
                    sha256 TEXT,
                    state TEXT NOT NULL DEFAULT 'pending',
                    position INTEGER NOT NULL DEFAULT 0,
                    reason TEXT,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    next_try INTEGER NOT NULL DEFAULT 0
                )
            """.trimIndent())
            db.execSQL("CREATE INDEX items_state ON items (state)")
        }

        override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
    }

    companion object {
        private const val TABLE = "items"
        private val COLUMNS = arrayOf("id", "uri", "kind", "folder", "bucket", "name", "size", "taken", "sha256",
            "state", "position", "attempts", "reason")

        fun fileName(server: String): String = "sync-${server.replace(Regex("[^A-Za-z0-9_-]"), "_").ifEmpty { "server" }}.db"

        /** Removes a server's index (signing out, or forgetting the server). */
        fun delete(context: Context, server: String) {
            context.deleteDatabase(fileName(server))
        }
    }
}
