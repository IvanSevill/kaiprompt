package com.kaiprompt.app

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.abs

/**
 * The look.
 *
 * Deliberately the same palette as the terminal — the coral accent, the muted grey, the same
 * greens and reds for the same meanings. The phone and the PC are two windows onto one tool,
 * and a job that is amber on your desk should not be orange in your pocket.
 */
object K {
    val Accent = Color(0xFFD97757)      // the Claude Code coral
    val Ok = Color(0xFF4CC38A)
    val Warn = Color(0xFFE2B254)
    val Err = Color(0xFFE5534B)
    val Info = Color(0xFF63B8C4)
    val Muted = Color(0xFF7C8A9A)

    val Bg = Color(0xFF0F1114)
    val Card = Color(0xFF181B21)
    val CardHi = Color(0xFF1F232B)
    val Line = Color(0xFF262B34)
    val Text = Color(0xFFE8EAED)

    val scheme = darkColorScheme(
        primary = Accent,
        background = Bg,
        surface = Card,
        onBackground = Text,
        onSurface = Text,
    )

    /** One colour and one glyph per status, decided once so nothing drifts. */
    fun statusColour(status: String) = when (status) {
        "done" -> Ok
        "running" -> Accent
        "pending" -> Info
        "missed" -> Warn
        else -> Err
    }

    fun statusIcon(status: String) = when (status) {
        "done" -> "✓"
        "running" -> "▶"
        "pending" -> "·"
        "missed" -> "⊘"
        else -> "✗"
    }

    fun statusLabel(status: String) = when (status) {
        "done" -> "terminado"
        "running" -> "corriendo"
        "pending" -> "en cola"
        "missed" -> "se pasó la hora"
        "error" -> "falló"
        else -> status
    }
}

@Composable
fun KaipTheme(content: @Composable () -> Unit) =
    MaterialTheme(colorScheme = K.scheme, content = content)

/** A small rounded label. Used for status, targets, times — anything that is a fact, not prose. */
@Composable
fun Chip(text: String, colour: Color, modifier: Modifier = Modifier, solid: Boolean = false) {
    Box(
        modifier
            .clip(RoundedCornerShape(6.dp))
            .background(if (solid) colour else colour.copy(alpha = 0.14f))
            .padding(horizontal = 7.dp, vertical = 3.dp),
    ) {
        Text(
            text,
            color = if (solid) K.Bg else colour,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

/**
 * "in 2h 15m", "hace 5 min" — a time you can act on.
 *
 * An absolute timestamp makes you do the arithmetic yourself, and the only question anyone
 * actually asks of a scheduled job is *how long until it goes*.
 */
fun relative(ms: Long, now: Long = System.currentTimeMillis()): String {
    val d = ms - now
    val future = d >= 0
    val s = abs(d) / 1000

    val text = when {
        s < 60 -> "${s}s"
        s < 3600 -> "${s / 60} min"
        s < 86400 -> "${s / 3600}h ${(s % 3600) / 60}m"
        else -> "${s / 86400}d ${(s % 86400) / 3600}h"
    }
    return if (future) "en $text" else "hace $text"
}

fun clock(ms: Long): String = SimpleDateFormat("d MMM · HH:mm", Locale.getDefault()).format(Date(ms))
