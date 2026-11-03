package com.starcore.mobile

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.load
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.soloader.SoLoader
import com.brentvatne.react.ReactNativeVideoManager
import com.starcore.mobile.music.MusicPackage
import com.starcore.mobile.music.PlayerRegistry
import com.starcore.mobile.privacy.PrivacyPackage
import com.starcore.mobile.buildinfo.BuildInfoPackage

/**
 * Standard React Native application bootstrap - autolinking (via
 * `PackageList`) is what wires in the native halves of react-native-keychain
 * and react-native-biometrics (see src/platform/), so neither is
 * hand-registered here. The one exception is the app's own Music package
 * (src/music/native.ts), which has no npm package to autolink from, and
 * its react-native-video plugin hook that gives it the player's session,
 * and the Privacy package (FLAG_SECURE and image-cache eviction for the
 * Locked Folder), and BuildInfo (Settings > About).
 */
class MainApplication : Application(), ReactApplication {

    override val reactNativeHost: ReactNativeHost =
        object : DefaultReactNativeHost(this) {
            override fun getPackages(): List<ReactPackage> = PackageList(this).packages + MusicPackage() + PrivacyPackage() + BuildInfoPackage()

            override fun getJSMainModuleName(): String = "index"

            override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

            override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
            override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED
        }

    override fun onCreate() {
        super.onCreate()
        SoLoader.init(this, false)
        ReactNativeVideoManager.getInstance().registerPlugin(PlayerRegistry)
        if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
            load()
        }
    }
}
