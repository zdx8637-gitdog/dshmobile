package dev.dshmobile.app.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import dev.dshmobile.app.net.ContextPressure
import dev.dshmobile.app.net.ProjectionsBlock
import dev.dshmobile.app.net.SessionStats
import dev.dshmobile.app.net.TokenUsage
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.math.roundToInt

/** 格式化毫秒为紧凑时长（109m4s）。 */
private fun fmtDuration(ms: Long): String {
    if (ms <= 0) return "0s"
    val totalSec = ms / 1000
    val m = totalSec / 60
    val s = totalSec % 60
    val h = m / 60
    val rm = m % 60
    return when {
        h > 0 -> "${h}h${rm}m"
        m > 0 -> "${m}m${s}s"
        else -> "${s}s"
    }
}

/** 大 token 数格式化（237M / 404 / 12.3k）。 */
private fun fmtTokens(n: Long): String = when {
    n >= 1_000_000 -> String.format("%.1fM", n / 1_000_000.0)
    n >= 1_000 -> String.format("%.1fk", n / 1_000.0)
    else -> n.toString()
}

/**
 * 会话统计条：单行横向滚动（手机宽度放不下），可放在消息列表顶部。
 * 布局：轮次/步数 | LLM/工具时长 | 首token/速率 | 缓存命中 | 输入/输出 | 上下文环
 */
@Composable
fun SessionStatsBar(projections: ProjectionsBlock?, modifier: Modifier = Modifier) {
    val values = projections?.values ?: return
    val stats = runCatching {
        kotlinx.serialization.json.Json { ignoreUnknownKeys = true }
            .decodeFromJsonElement(SessionStats.serializer(), values["sessionStats"]!!)
    }.getOrNull() ?: return
    val usage = values["tokenUsage"]?.let {
        runCatching {
            kotlinx.serialization.json.Json { ignoreUnknownKeys = true }
                .decodeFromJsonElement(TokenUsage.serializer(), it)
        }.getOrNull()
    }
    val pressure = values["contextPressure"]?.let {
        runCatching {
            kotlinx.serialization.json.Json { ignoreUnknownKeys = true }
                .decodeFromJsonElement(ContextPressure.serializer(), it)
        }.getOrNull()
    }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Stat("${stats.turns} 轮", "${stats.steps} 步")
        Stat("LLM ${fmtDuration(stats.llmMs)}", "工具 ${fmtDuration(stats.toolMs)}")
        val ttftAvg = if (stats.ttftSteps > 0) stats.ttftMs.toDouble() / stats.ttftSteps / 1000 else 0.0
        val tokPerSec = if (stats.decodeMs > 0) stats.decodeTokens.toDouble() / (stats.decodeMs / 1000.0) else 0.0
        Stat("首token ${String.format("%.1f", ttftAvg)}s", "${tokPerSec.roundToInt()} tok/s")
        if (usage != null) {
            val cacheTotal = usage.cacheReadTokens + usage.uncachedInputTokens
            val cachePct = if (cacheTotal > 0) (usage.cacheReadTokens * 100.0 / cacheTotal).roundToInt() else 0
            Stat("缓存 ${cachePct}%", "输入 ${fmtTokens(cacheTotal)}")
        }
        if (usage != null) {
            Stat("输出 ${fmtTokens(usage.outputTokens)}", "")
        }
        if (pressure != null && pressure.contextWindow > 0) {
            ContextRing(
                percentage = (pressure.pressureTokens * 100.0 / pressure.contextWindow)
                    .coerceIn(0.0, 100.0),
                sizeDp = 18,
            )
        }
    }
}

@Composable
private fun Stat(primary: String, secondary: String) {
    Column {
        Text(primary, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (secondary.isNotEmpty()) {
            Text(secondary, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.outline)
        }
    }
}

/** 上下文填充环（老项目 ContextUsageRing 的 Compose 等价物）。 */
@Composable
fun ContextRing(percentage: Double, sizeDp: Int, modifier: Modifier = Modifier) {
    val strokeWidth = 3.dp
    val baseColor = MaterialTheme.colorScheme.outline.copy(alpha = 0.4f)
    val progressColor = MaterialTheme.colorScheme.primary
    Canvas(modifier = modifier.size(sizeDp.dp)) {
        val strokePx = strokeWidth.toPx()
        val radius = (size.width - strokePx) / 2
        val center = androidx.compose.ui.geometry.Offset(size.width / 2, size.height / 2)
        // 底环
        drawCircle(
            color = baseColor,
            radius = radius,
            center = center,
            style = Stroke(width = strokePx),
        )
        // 进度弧
        val sweep = (percentage / 100.0 * 360.0).toFloat()
        if (sweep > 0f) {
            drawArc(
                color = progressColor,
                startAngle = -90f,
                sweepAngle = sweep,
                useCenter = false,
                topLeft = androidx.compose.ui.geometry.Offset(strokePx / 2, strokePx / 2),
                size = androidx.compose.ui.geometry.Size(size.width - strokePx, size.height - strokePx),
                style = Stroke(width = strokePx, cap = StrokeCap.Round),
            )
        }
    }
}

/** 从投影块读 goal 文本。 */
fun goalText(projections: ProjectionsBlock?): String? {
    val goal = projections?.values?.get("goal") ?: return null
    if (goal.toString() == "null") return null
    return try {
        val obj = goal.jsonObject
        obj["objective"]?.jsonPrimitive?.contentOrNull ?: obj.toString().take(120)
    } catch (_: Exception) { null }
}
