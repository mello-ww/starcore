package com.starcore.mobile.privacy

import android.content.Context
import android.view.WindowManager
import com.facebook.react.bridge.ReactContext
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.views.view.ReactViewGroup
import com.facebook.react.views.view.ReactViewManager

/**
 * A view that makes the window it is drawn in uncapturable (FLAG_SECURE), for
 * private content shown in a window of its own.
 *
 * PrivacyModule.setSecure covers the activity's window. A React Native Modal
 * is a Dialog with its own window, which does not take that flag from the
 * activity: without this, what a Modal shows - a full-screen viewer, a prompt,
 * a revealed secret - could still be captured in a screenshot or a recording
 * while the screen behind it could not.
 *
 * The flag is set when the view is attached, on whichever window that is, and
 * stays for that window's life (a Modal's ends with it). In the activity's own
 * window it does nothing: that one is counted by PrivacyModule.
 */
class SecureWindowView(context: Context) : ReactViewGroup(context) {
    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        secureWindow()
    }

    private fun secureWindow() {
        val root = rootView ?: return
        val params = root.layoutParams as? WindowManager.LayoutParams ?: return
        if (params.flags and WindowManager.LayoutParams.FLAG_SECURE != 0) {
            return
        }
        val activity = (context as? ReactContext)?.currentActivity
        if (activity != null && root === activity.window?.decorView) {
            return
        }
        val manager = activity?.windowManager
            ?: context.getSystemService(Context.WINDOW_SERVICE) as? WindowManager
            ?: return
        params.flags = params.flags or WindowManager.LayoutParams.FLAG_SECURE
        try {
            manager.updateViewLayout(root, params)
        } catch (error: RuntimeException) {
            // the window went away meanwhile: nothing left to protect
        }
    }
}

class SecureWindowManager : ReactViewManager() {
    override fun getName() = NAME

    override fun createViewInstance(context: ThemedReactContext): ReactViewGroup = SecureWindowView(context)

    companion object {
        const val NAME = "StarCoreSecureWindow"
    }
}
