package dev.dshmobile.app.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.dshmobile.app.net.DirListing
import dev.dshmobile.app.net.WorkspaceInfo
import kotlinx.coroutines.launch

/**
 * 新建会话目录选择弹窗（全程点选，无需手输路径）：
 * ① 工作区列表——点选即建会话；② 浏览目录——「此电脑」盘符层 → 逐层点开（面包屑回退/换盘）。
 */
@Composable
fun DirectoryPickerDialog(
    onListWorkspaces: suspend () -> List<WorkspaceInfo>,
    onListDrives: suspend () -> List<String>,
    onListDirectory: suspend (String?) -> DirListing?,
    onCreateFolder: suspend (String, String) -> Boolean,
    onCreateAt: suspend (cwd: String?, workspaceId: String?) -> Boolean,
    onDismiss: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var browseMode by remember { mutableStateOf(false) }
    var atComputerLevel by remember { mutableStateOf(false) }
    var drives by remember { mutableStateOf<List<String>?>(null) }
    var workspaces by remember { mutableStateOf<List<WorkspaceInfo>?>(null) }
    var listing by remember { mutableStateOf<DirListing?>(null) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var showNewFolder by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        workspaces = onListWorkspaces()
    }

    fun browse(path: String?) {
        scope.launch {
            loading = true
            error = null
            val result = onListDirectory(path)
            loading = false
            if (result != null) {
                listing = result
                browseMode = true
                atComputerLevel = false
            }
        }
    }

    fun enterBrowse() {
        browseMode = true
        atComputerLevel = true
        scope.launch {
            loading = true
            val found = onListDrives()
            loading = false
            if (found.isEmpty()) {
                // 非 Windows 环境：无盘符，直接回 home 目录浏览
                browse(null)
            } else {
                drives = found
            }
        }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                if (browseMode && listing != null) "选择目录" else "新建会话：选择目录",
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        },
        text = {
            Column(Modifier.fillMaxWidth().heightIn(min = 240.dp, max = 420.dp)) {
                if (!browseMode) {
                    // 工作区列表
                    ListItem(
                        headlineContent = { Text("使用默认目录（快速新建）", color = MaterialTheme.colorScheme.primary) },
                        modifier = Modifier.clickable {
                            scope.launch { if (onCreateAt(null, null)) onDismiss() else error = "创建会话失败，请换一个目录" }
                        },
                    )
                    if (workspaces == null) {
                        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                            Spacer(Modifier.width(8.dp))
                            Text("加载工作区…", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.outline)
                        }
                    } else if (workspaces!!.isEmpty()) {
                        Text("（无工作区）", Modifier.padding(16.dp), color = MaterialTheme.colorScheme.outline, style = MaterialTheme.typography.bodySmall)
                    } else {
                        LazyColumn(Modifier.weight(1f, fill = false)) {
                            items(workspaces!!) { ws ->
                                ListItem(
                                    headlineContent = { Text(ws.title, maxLines = 1, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurface) },
                                    supportingContent = { Text(ws.path, maxLines = 1, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall) },
                                    modifier = Modifier.clickable {
                                        scope.launch { if (onCreateAt(null, ws.workspaceId)) onDismiss() else error = "创建会话失败，请换一个目录" }
                                    },
                                )
                            }
                        }
                    }
                    ListItem(
                        headlineContent = { Text("浏览目录…", color = MaterialTheme.colorScheme.primary) },
                        modifier = Modifier.clickable { enterBrowse() },
                    )
                } else if (atComputerLevel) {
                    // 「此电脑」层级：点盘符进入
                    if (drives == null) {
                        if (loading) {
                            Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                                Spacer(Modifier.width(8.dp))
                                Text("读取盘符…", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.outline)
                            }
                        }
                    } else {
                        LazyColumn(Modifier.weight(1f, fill = false)) {
                            items(drives!!) { drive ->
                                ListItem(
                                    leadingContent = { Text("💽", color = MaterialTheme.colorScheme.onSurfaceVariant) },
                                    headlineContent = { Text(drive, color = MaterialTheme.colorScheme.onSurface) },
                                    modifier = Modifier.clickable { browse(drive) },
                                )
                            }
                        }
                    }
                } else {
                    val dir = listing
                    if (dir == null) {
                        if (loading) {
                            Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                                Spacer(Modifier.width(8.dp))
                                Text("读取目录…", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.outline)
                            }
                        }
                    } else {
                        // 面包屑：📀 回「此电脑」，🏠 回 home，crumb 沿祖先链回退
                        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), verticalAlignment = Alignment.CenterVertically) {
                            TextButton(onClick = { atComputerLevel = true }) { Text("📀", color = MaterialTheme.colorScheme.primary) }
                            TextButton(onClick = { browse(dir.home) }) { Text("🏠", color = MaterialTheme.colorScheme.primary) }
                            dir.crumbs.forEach { crumb ->
                                TextButton(onClick = { browse(crumb.path) }) {
                                    Text(crumb.name, color = MaterialTheme.colorScheme.primary, maxLines = 1, style = MaterialTheme.typography.labelMedium)
                                }
                            }
                        }
                        HorizontalDivider()
                        LazyColumn(Modifier.weight(1f, fill = false)) {
                            items(dir.entries) { entry ->
                                ListItem(
                                    leadingContent = { Text("📁", color = MaterialTheme.colorScheme.onSurfaceVariant) },
                                    headlineContent = { Text(entry.name, maxLines = 1, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurface) },
                                    modifier = Modifier.clickable { browse(entry.path) },
                                )
                            }
                            if (dir.entries.isEmpty()) {
                                item { Text("（空目录）", Modifier.padding(16.dp), color = MaterialTheme.colorScheme.outline, style = MaterialTheme.typography.bodySmall) }
                            }
                        }
                        if (loading) {
                            Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                                Spacer(Modifier.width(8.dp))
                                Text("读取目录…", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.outline)
                            }
                        }
                        HorizontalDivider()
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                            TextButton(onClick = { showNewFolder = true }) { Text("新建文件夹", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelMedium) }
                            Row {
                                TextButton(onClick = { browseMode = false }) { Text("返回工作区", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelMedium) }
                                TextButton(onClick = {
                                    scope.launch { if (onCreateAt(dir.path, null)) onDismiss() else error = "创建会话失败，该目录不可用（如盘符根目录）" }
                                }) { Text("使用此目录", color = MaterialTheme.colorScheme.primary) }
                            }
                        }
                    }
                }
                if (error != null) {
                    Text(error!!, Modifier.padding(horizontal = 8.dp), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, maxLines = 2)
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text("取消", color = MaterialTheme.colorScheme.onSurfaceVariant) }
        },
    )

    // 新建文件夹
    if (showNewFolder) {
        var name by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { showNewFolder = false },
            title = { Text("新建文件夹") },
            text = {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    singleLine = true,
                    placeholder = { Text("文件夹名") },
                    modifier = Modifier.fillMaxWidth(),
                )
            },
            confirmButton = {
                TextButton(
                    enabled = name.isNotBlank(),
                    onClick = {
                        val current = listing
                        scope.launch {
                            if (current != null && onCreateFolder(current.path, name.trim())) {
                                showNewFolder = false
                                browse(current.path)  // 刷新列表
                            }
                        }
                    },
                ) { Text("创建", color = MaterialTheme.colorScheme.primary) }
            },
            dismissButton = {
                TextButton(onClick = { showNewFolder = false }) { Text("取消", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            },
        )
    }
}
