package com.starcore.mobile.sync

import java.net.URI
import java.net.URLEncoder

/** One item's state in the local index. */
enum class ItemState(val code: String) {
    PENDING("pending"),
    UPLOADING("uploading"),
    DONE("done"),
    FAILED("failed");

    companion object {
        fun of(code: String?): ItemState = values().firstOrNull { it.code == code } ?: PENDING
    }
}

/** Why an item failed, as the sync screen words it. */
object Reasons {
    /** larger than the provider takes */
    const val TOO_LARGE = "too-large"
    /** the provider could not read it as an image or a video */
    const val UNREADABLE = "unreadable"
    /** what arrived never matched its SHA-256, the file kept changing while it was sent */
    const val CHANGING = "changing"
    /** the phone could not open it */
    const val MISSING = "missing"
    /** the provider refused it for another reason */
    const val REFUSED = "refused"
}

/** What one answer of the provider's upload operation means for the item being sent. */
sealed class Answer {
    /** the bytes arrived; go on from `offset` */
    data class Progress(val offset: Long) : Answer()
    /** the whole file is in the library (imported, or it already had it) */
    object Finished : Answer()
    /** the provider holds another offset: go on from there */
    data class Resume(val offset: Long) : Answer()
    /** the whole file did not match its digest: hash it again and send it from 0 */
    object Restart : Answer()
    /** this item fails, for `reason`; `final` items wait for "Try again" */
    data class Fail(val reason: String, val final: Boolean) : Answer()
    /** the whole run stops: `phase` is what the screen says; `retry` reschedules it with backoff */
    data class Stop(val phase: String, val retry: Boolean) : Answer()
}

/** One media's version on the phone: its MediaStore id, size, modification time and generation. */
data class Version(val id: Long, val size: Long, val modified: Long, val generation: Long)

/** What a scan changes in the index (ids). */
data class Reconciled(val added: List<Long>, val changed: List<Long>, val removed: List<Long>)

/** The phases a run reports to the screen. */
object Phases {
    const val IDLE = "idle"
    const val SCANNING = "scanning"
    const val UPLOADING = "uploading"
    const val OFFLINE = "offline"
    const val PERMISSION = "permission"
    const val SIGNED_OUT = "signed-out"
    const val UNAVAILABLE = "unavailable"
    const val SERVER_FULL = "server-full"
}

/**
 * The background backup's rules that need no device: chunk planning, what an answer means,
 * an item's retries and backoff, and what may be called. The worker (SyncRun) applies them;
 * SyncRulesTest checks them on the JVM.
 */
object SyncRules {
    /** a failed item is retried this many times with backoff, then waits for "Try again" */
    const val MAX_ATTEMPTS = 5
    /** the most items one check asks about (the protocol's limit) */
    const val CHECK_BATCH = 500
    /** used when the provider names no chunk size */
    const val DEFAULT_CHUNK = 8L * 1024 * 1024
    /** never more per request than this, whatever the provider says */
    const val MAX_CHUNK = 64L * 1024 * 1024
    /** the shortest wait before a run scheduled for a failed item's retry */
    const val MIN_LATER = 15_000L
    private const val FIRST_BACKOFF = 60_000L
    private const val MAX_BACKOFF = 6 * 60 * 60_000L
    private val ROUTE = Regex("^[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)*$")
    private val NAME = Regex("^[A-Za-z0-9_.-]{1,64}$")
    private val DIGEST = Regex("^[0-9a-f]{64}$")

    /** The provider's chunk size, kept within (0, MAX_CHUNK]. */
    fun chunkSize(announced: Long?): Long =
        if (announced == null || announced <= 0) DEFAULT_CHUNK else minOf(announced, MAX_CHUNK)

    /** The next chunk to send, (start, length), or null when the file is complete. */
    fun nextChunk(size: Long, offset: Long, chunk: Long): Pair<Long, Long>? {
        require(chunk > 0) { "chunk must be positive" }
        if (offset < 0 || offset >= size) return null
        return offset to minOf(chunk, size - offset)
    }

    /** Every chunk from `offset` to the end, in order. */
    fun chunks(size: Long, offset: Long, chunk: Long): List<Pair<Long, Long>> {
        val all = mutableListOf<Pair<Long, Long>>()
        var at = offset
        while (true) {
            val next = nextChunk(size, at, chunk) ?: break
            all.add(next)
            at = next.first + next.second
        }
        return all
    }

    /** How long a failed item waits before its `attempts`-th retry: one minute, doubling, at
     * most six hours. */
    fun backoffMillis(attempts: Int): Long {
        if (attempts <= 1) return FIRST_BACKOFF
        val doubled = FIRST_BACKOFF shl minOf(attempts - 1, 20)
        return minOf(doubled, MAX_BACKOFF)
    }

    /** An item that failed once more: (its attempts, when it may be retried). Past MAX_ATTEMPTS,
     * or for a `final` failure, it waits for "Try again" (Long.MAX_VALUE). */
    fun failure(attempts: Int, now: Long, final: Boolean): Pair<Int, Long> {
        val next = attempts + 1
        if (final || next >= MAX_ATTEMPTS) return next to Long.MAX_VALUE
        return next to now + backoffMillis(next)
    }

    /** Whether the phone's copy changed since it was indexed: an edit is a new file. */
    fun changed(size: Long, modified: Long, generation: Long, newSize: Long, newModified: Long, newGeneration: Long): Boolean =
        size != newSize || modified != newModified || generation != newGeneration

    /** What a scan does to the index: media new to it are added (pending), changed ones go back
     * to pending to be hashed again, and those gone from the phone or from the chosen folders
     * leave it (the server keeps what it has: nothing is deleted anywhere). */
    fun reconcile(indexed: Map<Long, Version>, scanned: List<Version>): Reconciled {
        val added = mutableListOf<Long>()
        val changed = mutableListOf<Long>()
        val seen = HashSet<Long>(scanned.size * 2)
        for (item in scanned) {
            seen.add(item.id)
            val known = indexed[item.id]
            when {
                known == null -> added.add(item.id)
                changed(known.size, known.modified, known.generation, item.size, item.modified, item.generation) ->
                    changed.add(item.id)
            }
        }
        val removed = indexed.keys.filter { it !in seen }.sorted()
        return Reconciled(added, changed, removed)
    }

    /** How long after a run the next one should start so that the soonest failed item is retried
     * once its backoff is over (`nextDue`, from the index), or null when no item waits on its own
     * backoff. Never less than MIN_LATER, so an item that came due during the run doesn't start
     * a run at once. */
    fun laterDelay(nextDue: Long?, now: Long): Long? {
        if (nextDue == null || nextDue == Long.MAX_VALUE) return null
        return maxOf(nextDue - now, MIN_LATER)
    }

    /** Whether a failed item may be tried again now (its backoff is over). */
    fun due(state: ItemState, nextTry: Long, now: Long): Boolean = state == ItemState.FAILED && nextTry <= now

    /** What an answer of upload (GET or POST) means. `offset` and `status` are the answer's own
     * fields, when it has them. */
    fun answer(code: Int, offset: Long?, status: String?): Answer = when {
        code == 200 && (status == "imported" || status == "duplicate") -> Answer.Finished
        code == 200 && offset != null && offset >= 0 -> Answer.Progress(offset)
        code == 200 -> Answer.Stop(Phases.OFFLINE, retry = true)
        // a chunk cut short keeps what arrived; a wrong offset names the right one
        (code == 400 || code == 409) && offset != null && offset >= 0 -> Answer.Resume(offset)
        code == 401 -> Answer.Stop(Phases.SIGNED_OUT, retry = false)
        code == 403 || code == 404 -> Answer.Stop(Phases.UNAVAILABLE, retry = false)
        code == 413 -> Answer.Fail(Reasons.TOO_LARGE, final = true)
        code == 415 -> Answer.Fail(Reasons.UNREADABLE, final = true)
        code == 422 -> Answer.Restart
        code == 507 -> Answer.Stop(Phases.SERVER_FULL, retry = true)
        code in 300..399 -> Answer.Stop(Phases.UNAVAILABLE, retry = false)
        code in 400..499 -> Answer.Fail(Reasons.REFUSED, final = false)
        else -> Answer.Stop(Phases.OFFLINE, retry = true)
    }

    /** What an answer of status or check means for the whole run: null when it may go on.
     * `answered` is whether a 200 carried what the operation answers: one that didn't is not
     * the provider speaking (a Wi-Fi sign-in page, a proxy's page), and nothing is concluded
     * from it about any item. */
    fun runAnswer(code: Int, answered: Boolean = true): Answer.Stop? = when {
        code == 200 && answered -> null
        code == 200 -> Answer.Stop(Phases.OFFLINE, retry = true)
        code == 401 -> Answer.Stop(Phases.SIGNED_OUT, retry = false)
        code == 403 || code == 404 || code in 300..399 -> Answer.Stop(Phases.UNAVAILABLE, retry = false)
        code == 507 -> Answer.Stop(Phases.SERVER_FULL, retry = true)
        else -> Answer.Stop(Phases.OFFLINE, retry = true)
    }

    /** The server's origin, scheme://host[:port], or null when it is anything else: the backup
     * only ever calls this origin, never another host. */
    fun origin(address: String): String? {
        val uri = try { URI(address.trim()) } catch (_: Exception) { return null }
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null
        val host = uri.host ?: return null
        if (uri.rawUserInfo != null || !(uri.rawPath.isNullOrEmpty() || uri.rawPath == "/")) return null
        if (uri.rawQuery != null || uri.rawFragment != null) return null
        val port = if (uri.port == -1) "" else ":${uri.port}"
        val shown = if (host.contains(':') && !host.startsWith("[")) "[$host]" else host
        return "$scheme://${shown.lowercase()}$port"
    }

    /** Whether a provider's satellite name and operation route are safe to put in a path. */
    fun validRoute(satellite: String, route: String): Boolean = NAME.matches(satellite) && ROUTE.matches(route)

    fun validDigest(digest: String): Boolean = DIGEST.matches(digest)

    /** The URL of one of the provider's operations, on the server's own origin. */
    fun operationUrl(origin: String, satellite: String, route: String, suffix: String = ""): String {
        require(validRoute(satellite, route)) { "invalid operation route" }
        return "$origin/api/satellites/${encode(satellite)}/$route$suffix"
    }

    /** upload's query: where these bytes start, the whole size, and what the library keeps. */
    fun uploadQuery(offset: Long, size: Long, name: String, folder: String, taken: Long?): String {
        val parts = mutableListOf("offset=$offset", "size=$size", "name=${encode(name)}", "folder=${encode(folder)}")
        if (taken != null && taken > 0) parts.add("taken=$taken")
        return parts.joinToString("&")
    }

    fun encode(value: String): String = URLEncoder.encode(value, "UTF-8").replace("+", "%20")
}
