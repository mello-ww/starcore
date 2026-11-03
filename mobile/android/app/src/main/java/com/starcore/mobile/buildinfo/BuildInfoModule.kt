package com.starcore.mobile.buildinfo

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.starcore.mobile.BuildConfig

/**
 * This app's own version and build metadata, as Gradle stamped it into
 * BuildConfig from the repository's VERSION file and Git (see
 * android/app/build.gradle). Constants only - read once by
 * src/platform/buildInfo.ts. Nothing here identifies the device or the user.
 */
class BuildInfoModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
    override fun getName(): String = "StarCoreBuildInfo"

    override fun getConstants(): Map<String, Any> = mapOf(
        "version" to BuildConfig.VERSION_NAME,
        "versionCode" to BuildConfig.VERSION_CODE,
        "channel" to BuildConfig.STARCORE_CHANNEL,
        "commit" to BuildConfig.STARCORE_COMMIT,
        "buildNumber" to BuildConfig.STARCORE_BUILD_NUMBER,
        "dirty" to BuildConfig.STARCORE_DIRTY,
        "buildDate" to BuildConfig.STARCORE_BUILD_DATE,
        "buildType" to BuildConfig.BUILD_TYPE,
    )
}
