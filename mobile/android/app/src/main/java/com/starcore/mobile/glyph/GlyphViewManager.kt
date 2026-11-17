package com.starcore.mobile.glyph

import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableType
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp

/** The native side of src/components/Glyph.tsx: a GlyphView with its paths, stroke and colour. */
class GlyphViewManager : SimpleViewManager<GlyphView>() {
    override fun getName() = NAME

    override fun createViewInstance(context: ThemedReactContext) = GlyphView(context)

    @ReactProp(name = "paths")
    fun setPaths(view: GlyphView, paths: ReadableArray?) {
        val data = mutableListOf<String>()
        if (paths != null) {
            for (index in 0 until minOf(paths.size(), MAX_PATHS)) {
                if (paths.getType(index) == ReadableType.String) {
                    paths.getString(index)?.let(data::add)
                }
            }
        }
        view.setPaths(data)
    }

    @ReactProp(name = "stroke", defaultFloat = 2f)
    fun setStroke(view: GlyphView, stroke: Float) {
        view.setStroke(stroke)
    }

    @ReactProp(name = "color", customType = "Color")
    fun setColor(view: GlyphView, color: Int?) {
        view.setColor(color ?: android.graphics.Color.WHITE)
    }

    companion object {
        const val NAME = "StarCoreGlyph"

        // what the Engine never exceeds (contracts/ui/vocabulary.json, limits.icon_paths)
        private const val MAX_PATHS = 32
    }
}
