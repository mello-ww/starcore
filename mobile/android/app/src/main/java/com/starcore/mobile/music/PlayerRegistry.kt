package com.starcore.mobile.music

import com.brentvatne.react.RNVPlugin

/**
 * Holds the ExoPlayer react-native-video creates for the Music player. Typed as Any and
 * reached through reflection so the app never compiles against media3 itself - it stays
 * whatever version react-native-video ships.
 */
object PlayerRegistry : RNVPlugin {
    @Volatile
    var player: Any? = null
        private set

    var listener: ((Any?) -> Unit)? = null

    override fun onInstanceCreated(id: String, player: Any) {
        this.player = player
        listener?.invoke(player)
    }

    override fun onInstanceRemoved(id: String, player: Any) {
        if (this.player === player) {
            this.player = null
            listener?.invoke(null)
        }
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
