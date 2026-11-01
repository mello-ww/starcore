package com.starcore.mobile.music

import android.content.Context
import android.media.audiofx.BassBoost
import android.media.audiofx.Equalizer
import android.media.audiofx.LoudnessEnhancer
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import kotlin.math.log10
import kotlin.math.pow
import kotlin.math.roundToInt

/** Effects on the real playback path: they attach to the player's own audio session. */
class StarCoreAudioModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
    private val main = Handler(Looper.getMainLooper())
    private var session = 0
    private var equalizer: Equalizer? = null
    private var bassBoost: BassBoost? = null
    private var loudness: LoudnessEnhancer? = null

    override fun getName() = "StarCoreAudio"

    private fun <T> onMain(promise: Promise, work: () -> T) {
        main.post {
            try {
                promise.resolve(work())
            } catch (error: Exception) {
                promise.resolve(result(false, error.message ?: "unsupported"))
            }
        }
    }

    private fun result(applied: Boolean, reason: String? = null) = Arguments.createMap().apply {
        putBoolean("applied", applied)
        if (reason != null) putString("reason", reason)
    }

    private fun ensureSession(): Boolean {
        val current = PlayerRegistry.audioSessionId()
        if (current == 0) return false
        if (current != session) {
            release()
            session = current
        }
        return true
    }

    private fun release() {
        listOf(equalizer, bassBoost, loudness).forEach { effect ->
            try {
                effect?.release()
            } catch (_: Exception) {
            }
        }
        equalizer = null
        bassBoost = null
        loudness = null
    }

    @ReactMethod
    fun setEqualizer(enabled: Boolean, bands: ReadableArray, preampDb: Double, promise: Promise) = onMain(promise) {
        if (!ensureSession()) return@onMain result(false, "no-player")
        val eq = equalizer ?: Equalizer(0, session).also { equalizer = it }
        if (!enabled) {
            eq.enabled = false
            return@onMain result(true)
        }
        val gains = (0 until bands.size()).map { bands.getDouble(it) }
        val (low, high) = eq.bandLevelRange.let { it[0].toInt() to it[1].toInt() }
        for (band in 0 until eq.numberOfBands) {
            val centerHz = eq.getCenterFreq(band.toShort()) / 1000.0
            val gain = interpolate(gains, centerHz) + preampDb
            val millibels = (gain * 100).roundToInt().coerceIn(low, high)
            eq.setBandLevel(band.toShort(), millibels.toShort())
        }
        eq.enabled = true
        result(true)
    }

    @ReactMethod
    fun setBassBoost(strength: Double, promise: Promise) = onMain(promise) {
        if (!ensureSession()) return@onMain result(false, "no-player")
        val boost = bassBoost ?: BassBoost(0, session).also { bassBoost = it }
        if (!boost.strengthSupported) return@onMain result(false, "unsupported")
        val value = (strength.coerceIn(0.0, 12.0) / 12.0 * 1000).roundToInt()
        boost.setStrength(value.toShort())
        boost.enabled = value > 0
        result(true)
    }

    @ReactMethod
    fun setLoudness(gainMillibels: Int, promise: Promise) = onMain(promise) {
        if (!ensureSession()) return@onMain result(false, "no-player")
        val enhancer = loudness ?: LoudnessEnhancer(session).also { loudness = it }
        enhancer.setTargetGain(gainMillibels.coerceIn(0, 1200))
        enhancer.enabled = gainMillibels > 0
        result(true)
    }

    @ReactMethod
    fun setPlaybackParameters(speed: Double, semitones: Double, promise: Promise) = onMain(promise) {
        val pitch = 2.0.pow(semitones.coerceIn(-12.0, 12.0) / 12.0).toFloat()
        val applied = PlayerRegistry.setPlaybackParameters(speed.coerceIn(0.5, 2.0).toFloat(), pitch)
        result(applied, if (applied) null else "no-player")
    }

    @ReactMethod
    fun getSessionInfo(promise: Promise) = onMain(promise) {
        Arguments.createMap().apply {
            putInt("audioSessionId", PlayerRegistry.audioSessionId())
            putBoolean("player", PlayerRegistry.player != null)
            putInt("equalizerBands", equalizer?.numberOfBands?.toInt() ?: 0)
        }
    }

    @ReactMethod
    fun getNetworkType(promise: Promise) {
        try {
            val manager = reactApplicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val capabilities = manager.getNetworkCapabilities(manager.activeNetwork)
            promise.resolve(
                when {
                    capabilities == null -> "none"
                    capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
                        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "wifi"
                    capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
                    else -> "other"
                },
            )
        } catch (error: Exception) {
            promise.resolve("unknown")
        }
    }

    override fun invalidate() {
        main.post { release() }
        super.invalidate()
    }

    companion object {
        val UI_BANDS = doubleArrayOf(31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0)

        /** The ten UI bands spread over however many bands this device's equalizer has. */
        fun interpolate(gains: List<Double>, hz: Double): Double {
            if (gains.size != UI_BANDS.size) return 0.0
            if (hz <= UI_BANDS.first()) return gains.first()
            if (hz >= UI_BANDS.last()) return gains.last()
            val position = log10(hz)
            for (index in 0 until UI_BANDS.size - 1) {
                val low = log10(UI_BANDS[index])
                val high = log10(UI_BANDS[index + 1])
                if (position in low..high) {
                    val ratio = (position - low) / (high - low)
                    return gains[index] + (gains[index + 1] - gains[index]) * ratio
                }
            }
            return 0.0
        }
    }
}
