package com.starcore.mobile.glyph

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.view.View
import kotlin.math.min

/**
 * A Satellite's own icon (UI contract 1.2): the path data the Engine validated, stroked in the
 * colour the app gives it with round caps and joins, scaled from its 24-unit box to the view's
 * size and centred - the way the app draws a shared icon. Paths it can't read are left out
 * (GlyphPaths); the app falls back to the shared icon when this view isn't there.
 */
class GlyphView(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
        color = Color.WHITE
        strokeWidth = 2f
    }
    private var paths: List<Path> = emptyList()

    fun setPaths(data: List<String>) {
        paths = data.mapNotNull { item -> GlyphPaths.parse(item)?.let(::toPath) }
        invalidate()
    }

    fun setStroke(width: Float) {
        paint.strokeWidth = width.coerceIn(0.5f, 3f)
        invalidate()
    }

    fun setColor(color: Int) {
        paint.color = color
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val box = min(width, height).toFloat()
        if (box <= 0f || paths.isEmpty()) {
            return
        }
        val scale = box / BOX
        canvas.save()
        canvas.translate((width - box) / 2f, (height - box) / 2f)
        canvas.scale(scale, scale)
        for (path in paths) {
            canvas.drawPath(path, paint)
        }
        canvas.restore()
    }

    private fun toPath(segments: List<GlyphPaths.Segment>): Path {
        val path = Path()
        for (segment in segments) {
            when (segment) {
                is GlyphPaths.Segment.Move -> path.moveTo(segment.x, segment.y)
                is GlyphPaths.Segment.Line -> path.lineTo(segment.x, segment.y)
                is GlyphPaths.Segment.Cubic -> path.cubicTo(segment.x1, segment.y1, segment.x2, segment.y2, segment.x, segment.y)
                GlyphPaths.Segment.Close -> path.close()
            }
        }
        return path
    }

    companion object {
        private const val BOX = 24f
    }
}
