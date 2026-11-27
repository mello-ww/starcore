package com.starcore.mobile.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ArtworkPaletteTest {
    private fun argb(r: Int, g: Int, b: Int, a: Int = 255) = (a shl 24) or (r shl 16) or (g shl 8) or b

    @Test
    fun `a saturated colour outweighs more grey pixels`() {
        val pixels = IntArray(10) { argb(128, 128, 128) } + IntArray(6) { argb(200, 40, 40) }
        // grey: 10 x 0.3 = 3; red: 6 x (0.3 + 0.8) = 6.6
        assertEquals("#c82828", ArtworkPalette.colour(pixels))
    }

    @Test
    fun `a dark cover is lifted so dark ink reads on it`() {
        assertEquals("#00aa55", ArtworkPalette.colour(IntArray(4) { argb(0, 60, 30) }))
    }

    @Test
    fun `a bucket's colour is its pixels' average`() {
        val pixels = intArrayOf(argb(200, 10, 10), argb(210, 20, 20))
        assertEquals("#cd0f0f", ArtworkPalette.colour(pixels))
    }

    @Test
    fun `transparent pixels count as black, and nothing gives no colour`() {
        assertEquals("#000000", ArtworkPalette.colour(IntArray(3) { argb(255, 0, 0, 0) }))
        assertNull(ArtworkPalette.colour(IntArray(0)))
    }

    @Test
    fun `the lift keeps bright colours and never passes 255`() {
        assertEquals(listOf(250, 10, 10), ArtworkPalette.lift(intArrayOf(250, 10, 10)).toList())
        assertEquals(listOf(106, 170, 0), ArtworkPalette.lift(intArrayOf(100, 160, 0)).toList())
    }
}
