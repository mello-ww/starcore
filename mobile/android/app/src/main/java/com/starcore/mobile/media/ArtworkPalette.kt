package com.starcore.mobile.media

import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * The most telling colour of a cover, by Mission Control's rule (media/theme.js): the pixels
 * of a small copy are grouped by colour, each weighted by its saturation (less for the near
 * black and near white), and the heaviest group's average is lifted so dark ink reads on it.
 */
object ArtworkPalette {
    const val SIZE = 24

    /** [pixels] are ARGB, as Bitmap.getPixels gives them; a transparent pixel counts as black. */
    fun colour(pixels: IntArray): String? {
        val buckets = LinkedHashMap<Int, DoubleArray>()
        for (pixel in pixels) {
            val visible = (pixel ushr 24) != 0
            val r = if (visible) (pixel shr 16) and 0xff else 0
            val g = if (visible) (pixel shr 8) and 0xff else 0
            val b = if (visible) pixel and 0xff else 0
            val high = max(r, max(g, b))
            val low = min(r, min(g, b))
            val saturation = if (high > 0) (high - low).toDouble() / high else 0.0
            val key = ((r shr 5) shl 6) or ((g shr 5) shl 3) or (b shr 5)
            val entry = buckets.getOrPut(key) { DoubleArray(5) }
            entry[0] += r.toDouble()
            entry[1] += g.toDouble()
            entry[2] += b.toDouble()
            entry[3] += 1.0
            entry[4] += 0.3 + saturation * (if (high in 41..244) 1.0 else 0.2)
        }
        val top = buckets.values.sortedByDescending { it[4] }.firstOrNull() ?: return null
        val rgb = IntArray(3) { (top[it] / top[3]).roundToInt() }
        return hex(lift(rgb))
    }

    /** Bright enough for dark on-accent text to stay readable on it. */
    fun lift(rgb: IntArray): IntArray {
        val high = rgb.max()
        if (high >= 170) return rgb
        val scale = 170.0 / max(high, 1)
        return IntArray(3) { min(255, (rgb[it] * scale).roundToInt()) }
    }

    fun hex(rgb: IntArray) = "#%02x%02x%02x".format(rgb[0], rgb[1], rgb[2])
}
