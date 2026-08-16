package dev.dshmobile.app.screens

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.dshmobile.app.net.ModelCatalogModel
import dev.dshmobile.app.net.ModelDirectory
import dev.dshmobile.app.net.ModelProviderGroup

/** 模型选择对话框：提供方 → 模型 → 思考强度。 */
@Composable
fun ModelPickerDialog(
    directory: ModelDirectory,
    onDismiss: () -> Unit,
    onSelect: (provider: String, model: String, effort: String?) -> Unit,
) {
    var selectedProvider by remember { mutableStateOf(directory.current.provider) }
    var selectedModel by remember { mutableStateOf(directory.current.model) }
    var selectedEffort by remember { mutableStateOf(directory.current.reasoningEffort) }

    val providerGroup = directory.groups.find { it.id == selectedProvider }
    val modelEntry = providerGroup?.models?.find { it.id == selectedModel }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("选择模型", color = MaterialTheme.colorScheme.onSurface) },
        text = {
            Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
                // 提供方
                Text("提供方", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                directory.groups.forEach { group ->
                    ProviderRow(group, selected = group.id == selectedProvider) { sel ->
                        selectedProvider = sel.id
                        // 切换提供方时重置为该组第一个模型
                        selectedModel = sel.models.firstOrNull()?.id ?: ""
                        selectedEffort = sel.models.firstOrNull()?.reasoning?.defaultEffort
                    }
                }
                Spacer(Modifier.height(12.dp))
                // 模型
                Text("模型", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                providerGroup?.models?.forEach { m ->
                    ModelRow(m, selected = m.id == selectedModel) {
                        selectedModel = m.id
                        selectedEffort = m.reasoning?.defaultEffort
                    }
                }
                // 思考强度
                val efforts = modelEntry?.reasoning?.efforts.orEmpty()
                if (efforts.isNotEmpty()) {
                    Spacer(Modifier.height(12.dp))
                    Text("思考强度", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    efforts.forEach { e ->
                        EffortRow(e.name, selected = e.id == selectedEffort) { selectedEffort = e.id }
                    }
                }
                // 失败组
                if (directory.failures.isNotEmpty()) {
                    Spacer(Modifier.height(12.dp))
                    directory.failures.forEach { f ->
                        Text("⚠ ${f.name}: ${f.message}", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        },
        confirmButton = {
            Button(onClick = { onSelect(selectedProvider, selectedModel, selectedEffort) }) { Text("应用") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("取消", color = MaterialTheme.colorScheme.primary) }
        },
    )
}

@Composable
private fun ProviderRow(group: ModelProviderGroup, selected: Boolean, onClick: (ModelProviderGroup) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.SpaceBetween) {
        Column(Modifier.weight(1f)) {
            Text(group.name, color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
            Text("${group.models.size} 个模型", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        RadioButton(selected = selected, onClick = { onClick(group) })
    }
}

@Composable
private fun ModelRow(m: ModelCatalogModel, selected: Boolean, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), horizontalArrangement = Arrangement.SpaceBetween) {
        Column(Modifier.weight(1f)) {
            Text(m.name, color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
            m.description?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
        RadioButton(selected = selected, onClick = onClick)
    }
}

@Composable
private fun EffortRow(name: String, selected: Boolean, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(name, color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
        RadioButton(selected = selected, onClick = onClick)
    }
}

/** 计划模式 / 权限预设 选择器。 */
@Composable
fun ControlSheet(
    planActive: Boolean?,
    onTogglePlan: (Boolean) -> Unit,
    onPreset: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("会话控制", color = MaterialTheme.colorScheme.onSurface) },
        text = {
            Column {
                Text("计划模式", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                    Text(
                        if (planActive == true) "已开启（只规划不执行，/plan off 关闭）" else "已关闭（/plan 开启）",
                        color = MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier.weight(1f),
                    )
                    Switch(
                        checked = planActive == true,
                        onCheckedChange = { on -> onTogglePlan(on) },
                    )
                }
                Spacer(Modifier.height(16.dp))
                Text("权限预设", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                PresetRow("read-only", "只读 · 执行前询问", onPreset)
                PresetRow("workspace-write", "可写工作区 · 执行前询问", onPreset)
                PresetRow("danger-full-access", "全权访问 · 不询问", onPreset)            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text("关闭", color = MaterialTheme.colorScheme.primary) }
        },
    )
}

@Composable
private fun PresetRow(id: String, label: String, onPreset: (String) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, color = MaterialTheme.colorScheme.onSurface)
        TextButton(onClick = { onPreset(id) }) { Text("应用", color = MaterialTheme.colorScheme.primary) }
    }
}
