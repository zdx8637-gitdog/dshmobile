package dev.dshmobile.app.screens

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * 授权确认页（方向二）：桌面端插件未登录时出授权码，手机（已登录）扫码后
 * 在此显式确认「允许这台电脑登录你的账号」——授权是安全底线，绝不静默。
 */
@Composable
fun GrantLoginScreen(
    code: String,
    username: String?,
    error: String?,
    granted: Boolean,
    onAllow: () -> Unit,
    onDeny: () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxSize().statusBarsPadding().padding(horizontal = 32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("授权请求", style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.onSurface)
        Spacer(Modifier.height(8.dp))
        Text(
            "这台电脑请求登录你的账号，允许后电脑端即可运行远程桥接。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(20.dp))
        Text(
            "账号：${username ?: "（未登录）"}",
            style = MaterialTheme.typography.titleMedium,
            color = MaterialTheme.colorScheme.primary,
        )
        Spacer(Modifier.height(8.dp))
        Text("授权码 $code", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.outline)
        Spacer(Modifier.height(28.dp))

        if (granted) {
            Text("已授权，电脑端正在登录…", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.titleMedium)
        } else {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedButton(onClick = onDeny, modifier = Modifier.weight(1f)) { Text("拒绝") }
                Button(
                    onClick = onAllow,
                    enabled = username != null,
                    modifier = Modifier.weight(1f),
                ) { Text("允许登录") }
            }
            if (username == null) {
                Spacer(Modifier.height(10.dp))
                Text("请先登录账号再授权", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
        }
        if (error != null) {
            Spacer(Modifier.height(16.dp))
            Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }
    }
}
