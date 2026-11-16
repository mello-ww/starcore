package com.starcore.mobile.sync

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** One server's backup: where it goes (the provider found in the server's catalog) and the
 * person's choices. Folders are MediaStore bucket ids; every folder is backed up unless it is
 * in `excluded`, so a new folder is included by default. */
data class SyncConfig(
    val server: String,
    val origin: String,
    val satellite: String,
    val statusRoute: String,
    val checkRoute: String,
    val uploadRoute: String,
    val device: String,
    val sessionId: String?,
    val enabled: Boolean,
    val mobileData: Boolean,
    val charging: Boolean,
    val excluded: Set<String>,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("origin", origin).put("satellite", satellite)
        .put("status", statusRoute).put("check", checkRoute).put("upload", uploadRoute)
        .put("device", device).put("sessionId", sessionId ?: JSONObject.NULL)
        .put("enabled", enabled).put("mobileData", mobileData).put("charging", charging)
        .put("excluded", JSONArray(excluded.sorted()))

    companion object {
        fun fromJson(server: String, json: JSONObject): SyncConfig? {
            val excluded = json.optJSONArray("excluded")
            return SyncConfig(
                server = server,
                origin = SyncRules.origin(json.optString("origin")) ?: return null,
                satellite = json.optString("satellite"),
                statusRoute = json.optString("status"),
                checkRoute = json.optString("check"),
                uploadRoute = json.optString("upload"),
                device = json.optString("device"),
                sessionId = if (json.isNull("sessionId")) null else json.optString("sessionId"),
                enabled = json.optBoolean("enabled"),
                mobileData = json.optBoolean("mobileData"),
                charging = json.optBoolean("charging"),
                excluded = (0 until (excluded?.length() ?: 0)).map { excluded!!.optString(it) }.toSet(),
            )
        }
    }
}

/** What the last run reported, for the screen. */
data class RunState(val phase: String, val done: Int, val total: Int, val lastRun: Long, val updated: Long)

/**
 * The backup's settings, its credential and its last run's state, per server, in the app's
 * private SharedPreferences. The credential (a device credential limited to one capability) is
 * encrypted with an AES key kept in the Android Keystore, which never leaves it; it is readable
 * without the person present, since the backup runs in the background.
 */
class SyncStore(context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun config(server: String): SyncConfig? {
        val raw = prefs.getString("$server.config", null) ?: return null
        return try { SyncConfig.fromJson(server, JSONObject(raw)) } catch (_: Exception) { null }
    }

    fun servers(): List<String> = prefs.all.keys.filter { it.endsWith(".config") }.map { it.removeSuffix(".config") }

    fun save(config: SyncConfig) {
        prefs.edit().putString("${config.server}.config", config.toJson().toString()).apply()
    }

    fun saveToken(server: String, token: String) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val sealed = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
        val value = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(sealed, Base64.NO_WRAP)
        prefs.edit().putString("$server.token", value).apply()
    }

    fun token(server: String): String? {
        val value = prefs.getString("$server.token", null) ?: return null
        return try {
            val (iv, sealed) = value.split(":", limit = 2).map { Base64.decode(it, Base64.NO_WRAP) }
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
            String(cipher.doFinal(sealed), Charsets.UTF_8)
        } catch (_: Exception) {
            null
        }
    }

    fun run(server: String): RunState {
        val raw = prefs.getString("$server.run", null)
        val json = try { if (raw == null) JSONObject() else JSONObject(raw) } catch (_: Exception) { JSONObject() }
        return RunState(
            phase = json.optString("phase", Phases.IDLE),
            done = json.optInt("done"),
            total = json.optInt("total"),
            lastRun = json.optLong("lastRun"),
            updated = json.optLong("updated"),
        )
    }

    fun saveRun(server: String, phase: String, done: Int = 0, total: Int = 0, finished: Boolean = false) {
        val now = System.currentTimeMillis()
        val lastRun = if (finished) now else run(server).lastRun
        val json = JSONObject().put("phase", phase).put("done", done).put("total", total)
            .put("lastRun", lastRun).put("updated", now)
        prefs.edit().putString("$server.run", json.toString()).apply()
    }

    /** MediaStore's state (MediaScanner.state) when the last run scanned for this server. */
    fun scannedAt(server: String): String? = prefs.getString("$server.scanned", null)

    fun saveScannedAt(server: String, state: String) {
        prefs.edit().putString("$server.scanned", state).apply()
    }

    /** Everything kept for a server: its settings, credential, run state and scan state. */
    fun forget(server: String) {
        prefs.edit().remove("$server.config").remove("$server.token").remove("$server.run").remove("$server.scanned").apply()
    }

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (keyStore.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    companion object {
        private const val PREFS = "starcore.sync"
        private const val KEYSTORE = "AndroidKeyStore"
        private const val ALIAS = "starcore.sync.credential"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
