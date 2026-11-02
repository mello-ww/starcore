package com.starcore.mobile.privacy

import android.net.Uri
import android.view.WindowManager
import com.facebook.drawee.backends.pipeline.Fresco
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray

/**
 * Keeps the Locked Folder off the screen and out of caches it shouldn't be in.
 *
 * setSecure: FLAG_SECURE while private content is showing - Android then
 * blocks screenshots and screen recording of the app and shows a blank card
 * for it in the recent-apps switcher. Requests are counted, so two private
 * screens open at once keep it on until both have closed.
 *
 * evictImages: drops images from React Native's image caches (memory and
 * disk) - used for a photo's library thumbnail once it has moved into the
 * Locked Folder, so the gallery's cache doesn't keep a copy of it.
 */
class PrivacyModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
    private var holders = 0

    override fun getName() = "StarCorePrivacy"

    @ReactMethod
    fun setSecure(secure: Boolean) {
        val activity = currentActivity ?: return
        activity.runOnUiThread {
            holders = if (secure) holders + 1 else maxOf(0, holders - 1)
            if (holders > 0) {
                activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            } else {
                activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
            }
        }
    }

    @ReactMethod
    fun evictImages(urls: ReadableArray) {
        if (!Fresco.hasBeenInitialized()) {
            return
        }
        val pipeline = Fresco.getImagePipeline()
        for (index in 0 until urls.size()) {
            val url = urls.getString(index) ?: continue
            pipeline.evictFromCache(Uri.parse(url))
        }
    }
}
