package com.starcore.mobile

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

/**
 * The native Android entry point - standard React Native boilerplate, not
 * StarCore-specific. Everything that *is* StarCore-specific (screens,
 * navigation, the API client) lives in src/, which this class only ever
 * hands off to by component name; see index.js.
 */
class MainActivity : ReactActivity() {

    // The name of the main component registered from `index.js`
    override fun getMainComponentName(): String = "StarCoreMobile"

    override fun createReactActivityDelegate(): ReactActivityDelegate =
        DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
