package dev.dshmobile.app.screens

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.dshmobile.app.state.normalizeRelayOrigin

/**
 * 扫码登录（方向一）确认页：桌面端已登录并出码，手机凭 6 位配对码换取同账号会话。
 * 经 deep link（dshmobile://pair?relay=…&code=…）进入，或在登录页手输配对码进入。
 */
@Composable
fun PairLoginScreen(
    code: String,
    relay: String?,
    currentRelay: String?,
    error: String?,
    onBack: () -> Unit,
    onLogin: () -> Unit,
) {
    val crossServer = !relay.isNullOrBlank() && !currentRelay.isNullOrBlank() &&
        normalizeRelayOrigin(relay) != normalizeRelayOrigin(currentRelay)
    Column(
        modifier = Modifier.fillMaxSize().statusBarsPadding().padding(horizontal = 32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("扫码登录", style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.onSurface)
        Spacer(Modifier.height(8.dp))
        Text(
            "将登录到电脑端出示的同一账号，全程无需输入密码。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (crossServer) {
            Spacer(Modifier.height(10.dp))
            Text(
                "注意：该二维码来自另一台服务器（$relay），与你当前登录的服务器（$currentRelay）不同，登录后将切换到该服务器。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
        Spacer(Modifier.height(24.dp))
        Text("配对码", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.outline)
        Text(
            code,
            style = MaterialTheme.typography.displayMedium,
            color = MaterialTheme.colorScheme.primary,
        )
        Spacer(Modifier.height(28.dp))
        Button(onClick = onLogin, modifier = Modifier.fillMaxWidth()) { Text("登录") }
        Spacer(Modifier.height(8.dp))
        TextButton(onClick = onBack, modifier = Modifier.fillMaxWidth()) { Text("返回") }
        if (error != null) {
            Spacer(Modifier.height(16.dp))
            Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }
    }
}
