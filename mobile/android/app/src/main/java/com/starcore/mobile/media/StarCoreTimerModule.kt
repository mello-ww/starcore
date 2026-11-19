package com.starcore.mobile.media

import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * One-shot timers on the main looper. React Native suspends its own JS timers while the
 * activity is paused, a locked screen included; these keep running, and each resolves its
 * promise with true when it fires or false when it is cancelled or replaced.
 */
class StarCoreTimerModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
    private val main = Handler(Looper.getMainLooper())
    private val pending = HashMap<Int, Pair<Runnable, Promise>>()

    override fun getName() = "StarCoreTimer"

    @ReactMethod
    fun start(id: Double, ms: Double, promise: Promise) {
        val key = id.toInt()
        main.post {
            drop(key)
            val run = Runnable { pending.remove(key)?.second?.resolve(true) }
            pending[key] = run to promise
            main.postDelayed(run, ms.toLong().coerceAtLeast(0L))
        }
    }

    @ReactMethod
    fun cancel(id: Double) {
        main.post { drop(id.toInt()) }
    }

    private fun drop(key: Int) {
        pending.remove(key)?.let { (run, promise) ->
            main.removeCallbacks(run)
            promise.resolve(false)
        }
    }

    override fun invalidate() {
        main.post {
            pending.values.forEach { (run, _) -> main.removeCallbacks(run) }
            pending.clear()
        }
        super.invalidate()
    }
}
