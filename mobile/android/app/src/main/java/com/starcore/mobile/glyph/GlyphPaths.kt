package com.starcore.mobile.glyph

/**
 * Reads a Satellite's own icon path (UI contract 1.2, docs/ui-contract.md "Icons"): the Engine
 * turns every SVG it accepts into path data of absolute M, L, C and Z only, numbers separated by
 * one space, in a 24-unit box. This reads exactly that and nothing else - no relative commands,
 * no arcs, no exponents - and gives null for anything outside it, so the view draws nothing
 * rather than guessing. It never sees an SVG.
 */
object GlyphPaths {
    sealed class Segment {
        data class Move(val x: Float, val y: Float) : Segment()
        data class Line(val x: Float, val y: Float) : Segment()
        data class Cubic(
            val x1: Float, val y1: Float, val x2: Float, val y2: Float, val x: Float, val y: Float,
        ) : Segment()
        object Close : Segment()
    }

    // what the Engine never exceeds (contracts/ui/vocabulary.json, limits.icon_bytes)
    const val MAX_LENGTH = 8192
    private const val MAX_COORDINATE = 1000f

    fun parse(data: String): List<Segment>? {
        if (data.isEmpty() || data.length > MAX_LENGTH || data[0] != 'M') {
            return null
        }
        val reader = Reader(data)
        val segments = mutableListOf<Segment>()
        while (!reader.done()) {
            val segment = when (reader.next()) {
                'M' -> reader.pair()?.let { (x, y) -> Segment.Move(x, y) }
                'L' -> reader.pair()?.let { (x, y) -> Segment.Line(x, y) }
                'C' -> {
                    val first = reader.pair()
                    val second = if (first != null && reader.space()) reader.pair() else null
                    val end = if (second != null && reader.space()) reader.pair() else null
                    if (first != null && second != null && end != null) {
                        Segment.Cubic(first.first, first.second, second.first, second.second, end.first, end.second)
                    } else {
                        null
                    }
                }
                'Z' -> Segment.Close
                else -> null
            } ?: return null
            segments.add(segment)
        }
        return segments
    }

    private class Reader(private val text: String) {
        private var at = 0

        fun done() = at >= text.length

        fun next(): Char = text[at++]

        fun space(): Boolean {
            if (at < text.length && text[at] == ' ') {
                at++
                return true
            }
            return false
        }

        fun pair(): Pair<Float, Float>? {
            val x = number() ?: return null
            if (!space()) {
                return null
            }
            val y = number() ?: return null
            return Pair(x, y)
        }

        // -?digits(.digits)?
        private fun number(): Float? {
            val start = at
            if (at < text.length && text[at] == '-') {
                at++
            }
            if (!digits()) {
                return null
            }
            if (at < text.length && text[at] == '.') {
                at++
                if (!digits()) {
                    return null
                }
            }
            val value = text.substring(start, at).toFloatOrNull() ?: return null
            return if (value.isFinite() && kotlin.math.abs(value) <= MAX_COORDINATE) value else null
        }

        private fun digits(): Boolean {
            val start = at
            while (at < text.length && text[at] in '0'..'9') {
                at++
            }
            return at > start
        }
    }
}
