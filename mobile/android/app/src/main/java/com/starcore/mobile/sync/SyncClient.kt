package com.starcore.mobile.sync

import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL

/** One answer: its HTTP status and JSON body (null when it had none). */
data class SyncResponse(val code: Int, val body: JSONObject?) {
    fun offset(): Long? = body?.let { if (it.has("offset") && !it.isNull("offset")) it.optLong("offset", -1) else null }
    fun status(): String? = body?.optString("status")?.takeIf { it.isNotEmpty() }
}

/**
 * Calls the provider's media.sync v1 operations (status, check, upload) on the server's own
 * origin, with the device credential as a Bearer header. Redirects are never followed: an
 * answer that points elsewhere ends the run. A cut connection throws, and the run is
 * rescheduled.
 */
class SyncClient(private val config: SyncConfig, private val token: String) {
    fun status(): SyncResponse =
        request("GET", url(config.statusRoute, "?device=${SyncRules.encode(config.device)}"))

    fun check(items: List<IndexedItem>): SyncResponse {
        val body = JSONObject().put("device", config.device).put("items", JSONArray(items.map {
            JSONObject().put("sha256", it.sha256).put("size", it.size)
        }))
        val bytes = body.toString().toByteArray(Charsets.UTF_8)
        return request("POST", url(config.checkRoute), "application/json", bytes.size.toLong()) { it.write(bytes) }
    }

    fun offset(digest: String): SyncResponse = request("GET", url(config.uploadRoute, "/${checked(digest)}"))

    /** Sends `length` bytes from `offset`, written by `write`. */
    fun chunk(item: IndexedItem, digest: String, offset: Long, length: Long, write: (OutputStream) -> Unit): SyncResponse {
        val query = SyncRules.uploadQuery(offset, item.size, item.name, item.folder, item.taken)
        return request("POST", url(config.uploadRoute, "/${checked(digest)}?$query"), "application/octet-stream", length, write)
    }

    private fun checked(digest: String): String {
        require(SyncRules.validDigest(digest)) { "invalid digest" }
        return digest
    }

    private fun url(route: String, suffix: String = ""): String =
        SyncRules.operationUrl(config.origin, config.satellite, route, suffix)

    private fun request(
        method: String,
        url: String,
        type: String? = null,
        length: Long = 0,
        write: ((OutputStream) -> Unit)? = null,
    ): SyncResponse {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            instanceFollowRedirects = false
            connectTimeout = 15_000
            readTimeout = 120_000
            useCaches = false
            setRequestProperty("Authorization", "Bearer $token")
            setRequestProperty("Accept", "application/json")
        }
        try {
            if (write != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", type ?: "application/octet-stream")
                connection.setFixedLengthStreamingMode(length)
                connection.outputStream.use(write)
            }
            val code = connection.responseCode
            val stream = if (code >= 400) connection.errorStream else connection.inputStream
            val text = stream?.use { answer(it) }
            val body = try { if (text.isNullOrBlank()) null else JSONObject(text) } catch (_: Exception) { null }
            return SyncResponse(code, body)
        } finally {
            connection.disconnect()
        }
    }

    /** An answer's text, or null past MAX_ANSWER: no answer of these operations is that long,
     * and one that is must not be held in memory by a job running in the background. */
    private fun answer(stream: InputStream): String? {
        val held = ByteArrayOutputStream()
        val buffer = ByteArray(1 shl 13)
        while (true) {
            val read = stream.read(buffer)
            if (read < 0) break
            if (held.size() + read > MAX_ANSWER) return null
            held.write(buffer, 0, read)
        }
        return held.toString("UTF-8")
    }

    private companion object {
        /** a check of 500 digests answers under 40 KiB */
        const val MAX_ANSWER = 1 shl 20
    }
}
