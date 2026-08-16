package dev.dshmobile.app.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp

/** 登录/注册。服务器地址使用仓库配置（默认生产 relay）。 */
@Composable
fun AuthScreen(
    error: String?,
    onLogin: (String, String) -> Unit,
    onRegister: (String, String) -> Unit,
    onPairLogin: (String) -> Unit,
    onScanRequest: () -> Unit,
) {
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var showRegister by remember { mutableStateOf(false) }
    var showPairDialog by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier.fillMaxSize().statusBarsPadding().padding(horizontal = 32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("DSH Mobile", style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.onSurface)
        Spacer(Modifier.height(24.dp))
        OutlinedTextField(
            value = username,
            onValueChange = { username = it },
            label = { Text("用户名") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text("密码") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(16.dp))
        Button(
            onClick = { onLogin(username.trim(), password) },
            enabled = username.isNotBlank() && password.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
        ) { Text("登录") }
        Spacer(Modifier.height(8.dp))
        TextButton(onClick = { showRegister = !showRegister }) {
            Text(if (showRegister) "已有账号，去登录" else "注册新账号")
        }
        TextButton(onClick = { showPairDialog = true }) {
            Text("扫码登录", color = MaterialTheme.colorScheme.primary)
        }
        if (showRegister) {
            Spacer(Modifier.height(8.dp))
            Button(
                onClick = { onRegister(username.trim(), password) },
                enabled = username.length >= 3 && password.length >= 6,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("注册并登录") }
        }
        if (error != null) {
            Spacer(Modifier.height(16.dp))
            Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }
    }

    // 扫码登录面板：一个入口——扫一扫为主，手动输入配对码兜底
    if (showPairDialog) {
        var code by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { showPairDialog = false },
            title = { Text("扫码登录") },
            text = {
                Column {
                    Button(
                        onClick = {
                            showPairDialog = false
                            onScanRequest()
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("扫一扫") }
                    Spacer(Modifier.height(16.dp))
                    Text(
                        "或手动输入桌面端显示的 6 位配对码",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = code,
                        onValueChange = { if (it.length <= 6 && it.all { c -> c.isDigit() }) code = it },
                        singleLine = true,
                        label = { Text("配对码") },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            },
            confirmButton = {
                TextButton(
                    enabled = code.length == 6,
                    onClick = {
                        showPairDialog = false
                        onPairLogin(code)
                    },
                ) { Text("登录", color = MaterialTheme.colorScheme.primary) }
            },
            dismissButton = {
                TextButton(onClick = { showPairDialog = false }) { Text("取消", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            },
        )
    }
}
