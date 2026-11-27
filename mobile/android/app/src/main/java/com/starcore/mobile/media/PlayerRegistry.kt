package com.starcore.mobile.media

import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.brentvatne.react.RNVPlugin

/**
 * Holds the ExoPlayers react-native-video creates for the audio host. There are two: the one
 * playing and the one holding the next track, loaded and paused (gapless playback). The effects
 * and the playback parameters go to the one playing, else the one set to play, else the newest.
 * Typed as Any and reached through reflection so the app never compiles against media3 itself -
 * it stays whatever version react-native-video ships.
 */
object PlayerRegistry : RNVPlugin {
    private val players = mutableListOf<Any>()

    var listener: ((Any?) -> Unit)? = null

    /** The player the effects follow. */
    val player: Any?
        @Synchronized get() = players.firstOrNull { flag(it, "isPlaying") }
            ?: players.lastOrNull { flag(it, "getPlayWhenReady") }
            ?: players.lastOrNull()

    @Synchronized
    override fun onInstanceCreated(id: String, player: Any) {
        players.add(player)
        listener?.invoke(player)
    }

    @Synchronized
    override fun onInstanceRemoved(id: String, player: Any) {
        if (players.remove(player)) {
            listener?.invoke(this.player)
        }
        // react-native-video posts a removed player's media notification once more after
        // releasing its session; it only disappeared when the last player went and the service
        // stopped. With the second player, one goes while the other plays: clear what it leaves.
        SWEEP_AFTER_MS.forEach { delay -> main.postDelayed({ sweep() }, delay) }
    }

    /** Set by the application: the notifications are read through it. */
    var context: Context? = null

    private val main = Handler(Looper.getMainLooper())

    /** Cancels the media notifications of players that are gone. */
    private fun sweep() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context?.getSystemService(NotificationManager::class.java) ?: return
        val live = synchronized(this) { players.map { it.hashCode() }.toSet() }
        try {
            manager.activeNotifications
                .filter { it.notification.channelId == MEDIA_CHANNEL && it.id !in live && it.id != PLACEHOLDER_ID }
                .forEach { manager.cancel(it.tag, it.id) }
        } catch (error: Exception) {
        }
    }

    // react-native-video's notification channel and its service's placeholder notification
    private const val MEDIA_CHANNEL = "RNVIDEO_SESSION_NOTIFICATION"
    private const val PLACEHOLDER_ID = 9999
    private val SWEEP_AFTER_MS = longArrayOf(500, 2000)

    private fun flag(player: Any, method: String): Boolean = try {
        player.javaClass.getMethod(method).invoke(player) as Boolean
    } catch (error: Exception) {
        false
    }

    fun audioSessionId(): Int {
        val current = player ?: return 0
        return try {
            current.javaClass.getMethod("getAudioSessionId").invoke(current) as Int
        } catch (error: Exception) {
            0
        }
    }

    fun setPlaybackParameters(speed: Float, pitch: Float): Boolean {
        val current = player ?: return false
        return try {
            val parametersClass = Class.forName("androidx.media3.common.PlaybackParameters")
            val parameters = parametersClass.getConstructor(Float::class.javaPrimitiveType, Float::class.javaPrimitiveType)
                .newInstance(speed, pitch)
            current.javaClass.getMethod("setPlaybackParameters", parametersClass).invoke(current, parameters)
            true
        } catch (error: Exception) {
            false
        }
    }
}
