package com.starcore.mobile.sync

import android.content.Context
import java.io.IOException
import java.io.InputStream

/** Why a run ended early: the phase the screen shows, and whether the run is rescheduled. */
class RunStopped(val phase: String, val retry: Boolean) : Exception(phase)

/**
 * One backup run for one server: scan the chosen folders, bring the index in line, hash what is
 * new, ask the provider which digests it wants, and send those in chunks from the offset the
 * provider holds. `stopped` is the worker's own flag (the system ended the run): the run stops
 * between chunks and the next one resumes where it was.
 */
class SyncRun(
    private val context: Context,
    private val store: SyncStore,
    private val config: SyncConfig,
    private val stopped: () -> Boolean,
    private val progress: (done: Int, total: Int) -> Unit,
) {
    /** true when the run should be rescheduled with backoff. */
    fun run(): Boolean {
        val server = config.server
        if (MediaScanner.access(context) != MediaAccess.FULL) {
            store.saveRun(server, Phases.PERMISSION)
            return false
        }
        val token = store.token(server)
        if (token == null) {
            store.saveRun(server, Phases.SIGNED_OUT)
            return false
        }
        val client = SyncClient(config, token)
        return try {
            SyncIndex(context, server).use { index -> sync(client, index) }
            false
        } catch (stop: RunStopped) {
            store.saveRun(server, stop.phase)
            stop.retry
        } catch (_: IOException) {
            store.saveRun(server, Phases.OFFLINE)
            true
        }
    }

    private fun sync(client: SyncClient, index: SyncIndex) {
        val server = config.server
        store.saveRun(server, Phases.SCANNING)
        index.reconcile(MediaScanner.scan(context, config.excluded))
        index.releaseDue(System.currentTimeMillis())

        val status = client.status()
        SyncRules.runAnswer(status.code)?.let { throw RunStopped(it.phase, it.retry) }
        val chunk = SyncRules.chunkSize(status.body?.optLong("chunk_bytes", 0))
        val maxBytes = status.body?.optLong("max_bytes", 0)?.takeIf { it > 0 } ?: Long.MAX_VALUE
        val accepts = status.body?.optJSONArray("accepts")?.let { list -> (0 until list.length()).map { list.optString(it) }.toSet() }
            ?: setOf("image", "video")

        // hash what is new or changed
        for (item in index.toSend(hashed = false)) {
            if (stopped()) return
            if (item.kind !in accepts) {
                fail(index, item, Reasons.REFUSED, final = true)
                continue
            }
            if (item.size > maxBytes) {
                fail(index, item, Reasons.TOO_LARGE, final = true)
                continue
            }
            val digest = try {
                MediaScanner.hash(context, item.uri, stopped) ?: return
            } catch (_: Exception) {
                // a file the phone can't open fails alone; the run goes on
                fail(index, item, Reasons.MISSING, final = false)
                continue
            }
            index.setHash(item.id, digest)
        }

        // ask which of them the provider wants: known ones are done
        val wanted = mutableListOf<IndexedItem>()
        for (batch in index.toSend(hashed = true).chunked(SyncRules.CHECK_BATCH)) {
            if (stopped()) return
            val answer = client.check(batch)
            SyncRules.runAnswer(answer.code)?.let { throw RunStopped(it.phase, it.retry) }
            val known = answer.body?.optJSONArray("known")?.let { list -> (0 until list.length()).map { list.optString(it) }.toSet() }
                ?: emptySet()
            val wants = answer.body?.optJSONArray("wanted")?.let { list -> (0 until list.length()).map { list.optString(it) }.toSet() }
                ?: emptySet()
            for (item in batch) {
                when (item.sha256) {
                    in known -> index.markDone(item.id)
                    in wants -> wanted.add(item)
                    else -> fail(index, item, Reasons.TOO_LARGE, final = true)
                }
            }
        }

        // send what is wanted, newest first
        store.saveRun(server, Phases.UPLOADING, 0, wanted.size)
        progress(0, wanted.size)
        wanted.forEachIndexed { position, item ->
            if (stopped()) return
            send(client, index, item, chunk)
            store.saveRun(server, Phases.UPLOADING, position + 1, wanted.size)
            progress(position + 1, wanted.size)
        }
        store.saveRun(server, Phases.IDLE, wanted.size, wanted.size, finished = true)
    }

    /** Sends one item from the provider's offset to its last byte. */
    private fun send(client: SyncClient, index: SyncIndex, item: IndexedItem, chunk: Long) {
        val digest = item.sha256 ?: return
        var offset = when (val answer = answerOf(client.offset(digest))) {
            is Answer.Progress -> answer.offset
            is Answer.Finished -> return index.markDone(item.id)
            else -> return apply(index, item, answer)
        }
        // a wrong offset more than a few times in a row means another sender: try later
        var resumes = 0
        while (true) {
            if (stopped()) return index.setOffset(item.id, offset)
            val (start, length) = SyncRules.nextChunk(item.size, offset, chunk) ?: (offset to 0L)
            if (length == 0L) {
                // every byte is held, but the provider has not answered with the result: start over
                return apply(index, item, Answer.Restart)
            }
            val answer = try {
                answerOf(client.chunk(item, digest, start, length) { out -> copy(item, start, length, out) })
            } catch (missing: MediaChanged) {
                return fail(index, item, Reasons.MISSING, final = false)
            }
            when (answer) {
                is Answer.Progress -> {
                    offset = answer.offset
                    resumes = 0
                    index.setOffset(item.id, offset)
                }
                is Answer.Resume -> {
                    offset = answer.offset
                    if (++resumes > 3) return fail(index, item, Reasons.REFUSED, final = false)
                    index.setOffset(item.id, offset)
                }
                is Answer.Finished -> return index.markDone(item.id)
                else -> return apply(index, item, answer)
            }
        }
    }

    private fun answerOf(response: SyncResponse): Answer =
        SyncRules.answer(response.code, response.offset(), response.status())

    /** What a failed answer does: the item fails, starts over, or the whole run stops. */
    private fun apply(index: SyncIndex, item: IndexedItem, answer: Answer) {
        when (answer) {
            is Answer.Stop -> throw RunStopped(answer.phase, answer.retry)
            is Answer.Fail -> fail(index, item, answer.reason, answer.final)
            is Answer.Restart -> {
                val (attempts, nextTry) = SyncRules.failure(item.attempts, System.currentTimeMillis(), final = false)
                index.restart(item.id, attempts, nextTry)
            }
            else -> Unit
        }
    }

    private fun fail(index: SyncIndex, item: IndexedItem, reason: String, final: Boolean) {
        val (attempts, nextTry) = SyncRules.failure(item.attempts, System.currentTimeMillis(), final)
        index.markFailed(item.id, reason, attempts, nextTry)
    }

    /** Writes `length` bytes of the media from `start`; the media changed if it has fewer. */
    private fun copy(item: IndexedItem, start: Long, length: Long, out: java.io.OutputStream) {
        val input: InputStream = try {
            MediaScanner.open(context, item.uri)
        } catch (_: Exception) {
            throw MediaChanged()
        }
        input.use {
            var skipped = 0L
            while (skipped < start) {
                val step = it.skip(start - skipped)
                if (step <= 0) {
                    if (it.read() < 0) throw MediaChanged()
                    skipped += 1
                } else {
                    skipped += step
                }
            }
            val buffer = ByteArray(1 shl 16)
            var left = length
            while (left > 0) {
                val read = it.read(buffer, 0, minOf(buffer.size.toLong(), left).toInt())
                if (read < 0) throw MediaChanged()
                out.write(buffer, 0, read)
                left -= read
            }
        }
    }

    /** The media is gone or shorter than indexed: it fails alone and is indexed again. */
    private class MediaChanged : IOException("the media changed")
}
