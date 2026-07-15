package com.kaiprompt.app

import android.content.Context
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Text
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.text.SimpleDateFormat
import java.util.Date
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin

@Immutable
private data class KaipColors(
    val accent: Color,
    val ok: Color,
    val warn: Color,
    val err: Color,
    val info: Color,
    val muted: Color,
    val bg: Color,
    val card: Color,
    val cardHi: Color,
    val line: Color,
    val text: Color,
)

private val DarkKaipColors = KaipColors(
    accent = Color(0xFFFF8A68),
    ok = Color(0xFF58D69A),
    warn = Color(0xFFF0BE59),
    err = Color(0xFFFF716A),
    info = Color(0xFF72CBD5),
    muted = Color(0xFFA1AAB6),
    bg = Color(0xFF101114),
    card = Color(0xFF191B20),
    cardHi = Color(0xFF22252C),
    line = Color(0xFF30343C),
    text = Color(0xFFF3F0EC),
)

private val LightKaipColors = KaipColors(
    accent = Color(0xFF9D3F26),
    ok = Color(0xFF147A4E),
    warn = Color(0xFF8A5A00),
    err = Color(0xFFB3262E),
    info = Color(0xFF146D78),
    muted = Color(0xFF626872),
    bg = Color(0xFFF7F3EE),
    card = Color(0xFFFFFCF8),
    cardHi = Color(0xFFF0EAE3),
    line = Color(0xFFD8D0C7),
    text = Color(0xFF24211E),
)

private val LocalKaipColors = staticCompositionLocalOf { DarkKaipColors }

/** Semantic product colours. Call sites name intent instead of binding to a theme mode. */
object K {
    val Accent: Color @Composable get() = LocalKaipColors.current.accent
    val Ok: Color @Composable get() = LocalKaipColors.current.ok
    val Warn: Color @Composable get() = LocalKaipColors.current.warn
    val Err: Color @Composable get() = LocalKaipColors.current.err
    val Info: Color @Composable get() = LocalKaipColors.current.info
    val Muted: Color @Composable get() = LocalKaipColors.current.muted
    val Bg: Color @Composable get() = LocalKaipColors.current.bg
    val Card: Color @Composable get() = LocalKaipColors.current.card
    val CardHi: Color @Composable get() = LocalKaipColors.current.cardHi
    val Line: Color @Composable get() = LocalKaipColors.current.line
    val Text: Color @Composable get() = LocalKaipColors.current.text

    @Composable
    fun statusColour(status: String) = when (status) {
        "done" -> Ok
        "running" -> Accent
        "pending" -> Info
        "quota" -> Warn
        "missed" -> Warn
        else -> Err
    }

    fun statusIcon(status: String) = when (status) {
        "done" -> "✓"
        "running" -> "▶"
        "pending" -> "·"
        "quota" -> "⏸"
        "missed" -> "⊘"
        else -> "✗"
    }

    fun statusLabel(context: Context, status: String) = when (status) {
        "done" -> context.getString(R.string.status_done)
        "running" -> context.getString(R.string.status_running)
        "pending" -> context.getString(R.string.status_pending)
        "quota" -> context.getString(R.string.status_quota)
        "missed" -> context.getString(R.string.status_missed)
        "error" -> context.getString(R.string.status_error)
        else -> status
    }
}

private val KaipTypography = Typography(
    headlineLarge = TextStyle(
        fontSize = 32.sp, lineHeight = 38.sp, fontWeight = FontWeight.Bold,
        fontFamily = FontFamily.Monospace, letterSpacing = (-0.8).sp,
    ),
    headlineSmall = TextStyle(
        fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.Bold,
        fontFamily = FontFamily.Monospace, letterSpacing = (-0.3).sp,
    ),
    titleLarge = TextStyle(
        fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight.Bold,
        fontFamily = FontFamily.Monospace, letterSpacing = (-0.2).sp,
    ),
    titleMedium = TextStyle(fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold),
    bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 21.sp),
    bodySmall = TextStyle(fontSize = 12.sp, lineHeight = 17.sp),
    labelLarge = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold),
    labelMedium = TextStyle(fontSize = 12.sp, lineHeight = 17.sp, fontWeight = FontWeight.SemiBold),
)

@Composable
fun KaipTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val colors = if (dark) DarkKaipColors else LightKaipColors
    val scheme = if (dark) {
        darkColorScheme(
            primary = colors.accent, onPrimary = colors.bg,
            secondary = colors.info, tertiary = colors.ok,
            background = colors.bg, surface = colors.card, surfaceVariant = colors.cardHi,
            onBackground = colors.text, onSurface = colors.text,
            outline = colors.line, error = colors.err,
        )
    } else {
        lightColorScheme(
            primary = colors.accent, onPrimary = Color.White,
            secondary = colors.info, tertiary = colors.ok,
            background = colors.bg, surface = colors.card, surfaceVariant = colors.cardHi,
            onBackground = colors.text, onSurface = colors.text,
            outline = colors.line, error = colors.err,
        )
    }
    CompositionLocalProvider(LocalKaipColors provides colors) {
        MaterialTheme(
            colorScheme = scheme,
            typography = KaipTypography,
            shapes = Shapes(
                small = RoundedCornerShape(8.dp),
                medium = RoundedCornerShape(14.dp),
                large = RoundedCornerShape(22.dp),
            ),
            content = content,
        )
    }
}

/** Six-point terminal mark, drawn so it stays crisp at every density. */
@Composable
fun Sparkle(size: Dp, modifier: Modifier = Modifier, colour: Color = K.Accent) {
    Canvas(modifier.size(size)) {
        val c = Offset(this.size.width / 2, this.size.height / 2)
        val r = this.size.minDimension / 2
        val path = Path()
        for (i in 0 until 6) {
            val a = (PI / 3 * i).toFloat()
            val b = a + (PI / 6).toFloat()
            val tip = Offset(c.x + r * cos(a), c.y + r * sin(a))
            val waist = Offset(c.x + r * 0.22f * cos(b), c.y + r * 0.22f * sin(b))
            if (i == 0) path.moveTo(tip.x, tip.y) else path.lineTo(tip.x, tip.y)
            path.lineTo(waist.x, waist.y)
        }
        path.close()
        drawPath(path, colour)
    }
}

@Composable
fun Rule(label: String, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(
            label.uppercase(), color = K.Muted, fontSize = 11.sp,
            fontWeight = FontWeight.Bold, letterSpacing = 1.2.sp,
            fontFamily = FontFamily.Monospace,
        )
        Spacer(Modifier.width(12.dp))
        Box(Modifier.weight(1f).height(1.dp).background(K.Line))
    }
}

@Composable
fun Chip(text: String, colour: Color, modifier: Modifier = Modifier, solid: Boolean = false) {
    Box(
        modifier.clip(RoundedCornerShape(7.dp))
            .background(if (solid) colour else colour.copy(alpha = 0.14f))
            .padding(horizontal = 8.dp, vertical = 4.dp),
    ) {
        Text(
            text, color = if (solid) K.Bg else colour,
            style = MaterialTheme.typography.labelMedium,
        )
    }
}

fun relative(context: Context, ms: Long, now: Long = System.currentTimeMillis()): String {
    val d = ms - now
    val future = d >= 0
    val s = abs(d) / 1000
    val text = when {
        s < 60 -> "${s}s"
        s < 3600 -> "${s / 60} min"
        s < 86400 -> "${s / 3600}h ${(s % 3600) / 60}m"
        else -> "${s / 86400}d ${(s % 86400) / 3600}h"
    }
    return context.getString(if (future) R.string.relative_future else R.string.relative_past, text)
}

fun clock(context: Context, ms: Long): String =
    SimpleDateFormat("d MMM · HH:mm", context.resources.configuration.locales[0]).format(Date(ms))

fun elapsed(since: Long, now: Long = System.currentTimeMillis()): String {
    val s = abs(now - since) / 1000
    return when {
        s < 60 -> "${s}s"
        s < 3600 -> "${s / 60} min"
        s < 86400 -> "${s / 3600}h ${(s % 3600) / 60}m"
        else -> "${s / 86400}d ${(s % 86400) / 3600}h"
    }
}
