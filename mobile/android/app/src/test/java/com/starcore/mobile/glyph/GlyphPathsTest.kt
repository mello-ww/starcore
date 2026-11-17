package com.starcore.mobile.glyph

import com.starcore.mobile.glyph.GlyphPaths.Segment
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class GlyphPathsTest {
    @Test
    fun readsWhatTheEngineWrites() {
        assertEquals(
            listOf(
                Segment.Move(2f, 12f),
                Segment.Line(22f, 12f),
                Segment.Cubic(22f, 17.523f, 17.523f, 22f, 12f, 22f),
                Segment.Close,
                Segment.Move(-1.5f, 0f),
                Segment.Line(1f, 1f),
            ),
            GlyphPaths.parse("M2 12L22 12C22 17.523 17.523 22 12 22ZM-1.5 0L1 1"),
        )
    }

    @Test
    fun refusesAnythingElse() {
        val refused = listOf(
            "", "L1 1", "M1 1l2 2", "M1 1 L2 2", "M1 1H2", "M1e3 1", "M1 1Q1 1 2 2", "M1 1C1 1 2 2",
            "M1", "M1 ", "M1.5. 2", "M- 1", "M1  1", "M1 1A1 1 0 0 1 2 2", "<path d='M0 0'/>", "M1 1001",
            "M" + "1 1L".repeat(3000) + "1 1",
        )
        for (data in refused) {
            assertNull(data.take(40), GlyphPaths.parse(data))
        }
    }
}
