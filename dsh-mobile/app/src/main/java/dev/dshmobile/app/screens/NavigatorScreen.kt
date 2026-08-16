package dev.dshmobile.app.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.dshmobile.app.net.DeviceSummary
import dev.dshmobile.app.net.DirListing
import dev.dshmobile.app.net.RemoteStatus
import dev.dshmobile.app.net.SessionSummary
import dev.dshmobile.app.net.WorkspaceInfo
import kotlinx.coroutines.launch

/** 会话显示标题：优先投影里的 title，否则用 session id 前段（UI 展示用，不落盘）。 */
fun sessionTitleOf(session: SessionSummary): String? =
    session.projections?.values?.get("title")?.let {
        it.toString().removeSurrounding("\"").takeIf { t -> t.isNotBlank() }
    }

/** 导航页：设备列表 + 会话树（主会话 + 折叠子会话）+ 归档区 + 每行操作（重命名/分叉/归档）。 */
@Composable
fun NavigatorScreen(
    devices: List<DeviceSummary>,
    remoteStatus: RemoteStatus,
    sessions: List<SessionSummary>,
    archivedIds: Set<String>,
    error: String?,
    onSelectDevice: (DeviceSummary) -> Unit,
    onRefreshDevices: () -> Unit,
    onLoadSessions: () -> Unit,
    onOpenSession: (SessionSummary) -> Unit,
    onListWorkspaces: suspend () -> List<WorkspaceInfo>,
    onListDrives: suspend () -> List<String>,
    onListDirectory: suspend (String?) -> DirListing?,
    onCreateFolder: suspend (String, String) -> Boolean,
    onCreateAt: suspend (String?, String?) -> Boolean,
    onRename: suspend (String, String) -> String?,
    onFork: suspend (String) -> String?,
    onArchive: suspend (String) -> Boolean,
    onDeleteDevice: (DeviceSummary) -> Unit,
    onScanRequest: () -> Unit,
    onLogout: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var expandedParents by remember { mutableStateOf(setOf<String>()) }
    var showArchived by remember { mutableStateOf(false) }
    var renameTarget by remember { mutableStateOf<SessionSummary?>(null) }
    var deleteTarget by remember { mutableStateOf<DeviceSummary?>(null) }
    var showDirPicker by remember { mutableStateOf(false) }

    val active = sessions.filter { it.sessionId !in archivedIds }
    val archived = sessions.filter { it.sessionId in archivedIds }

    Column(Modifier.fillMaxSize().statusBarsPadding()) {
        // 顶栏
        Row(
            Modifier.fillMaxWidth().padding(16.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column {
                Text("设备", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface)
                Text(
                    when (remoteStatus) {
                        RemoteStatus.CONNECTED -> "已连接"
                        RemoteStatus.CONNECTING -> "连接中…"
                        RemoteStatus.RECONNECTING -> "重连中…"
                        RemoteStatus.AUTH_EXPIRED -> "认证过期"
                        RemoteStatus.DISCONNECTED -> "未连接"
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = if (remoteStatus == RemoteStatus.CONNECTED) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                )
            }
            Row {
                TextButton(onClick = onScanRequest) { Text("扫码", color = MaterialTheme.colorScheme.primary) }
                TextButton(onClick = onRefreshDevices) { Text("刷新", color = MaterialTheme.colorScheme.primary) }
                TextButton(onClick = onLogout) { Text("退出", color = MaterialTheme.colorScheme.primary) }
            }
        }

        // 设备列表
        LazyColumn(Modifier.weight(1f)) {
            items(devices) { device ->
                ListItem(
                    headlineContent = { Text(device.label, maxLines = 1, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurface) },
                    supportingContent = { Text("${device.platform ?: "other"} · ${device.status}", color = MaterialTheme.colorScheme.onSurfaceVariant) },
                    leadingContent = {
                        Text(
                            if (device.status == "online") "●" else "○",
                            color = if (device.status == "online") MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline,
                        )
                    },
                    trailingContent = {
                        // 无效条目（离线/已吊销）可删除：服务器端吊销，所有端同步消失；
                        // 电脑重新登录会自动重新注册回来（误删可恢复）。
                        if (device.status != "online") {
                            IconButton(onClick = { deleteTarget = device }) {
                                Icon(Icons.Filled.Delete, "删除无效设备", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    },
                    modifier = Modifier.clickable(enabled = device.status == "online") { onSelectDevice(device) },
                )
            }
            if (devices.isEmpty()) {
                item { Text("无设备：请先在电脑上启动 bridge", Modifier.padding(16.dp), color = MaterialTheme.colorScheme.outline) }
            }
        }

        // 会话树（选中设备后加载）
        if (remoteStatus == RemoteStatus.CONNECTED) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("会话", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface)
                TextButton(onClick = onLoadSessions) { Text("刷新会话", color = MaterialTheme.colorScheme.primary) }
            }
            LazyColumn(Modifier.weight(1.2f)) {
                val tree = sessionTree(active)
                items(tree) { (root, children) ->
                    SessionRow(
                        root,
                        isSub = false,
                        onClick = { onOpenSession(root) },
                        onRename = { renameTarget = root },
                        onFork = { scope.launch { onFork(root.sessionId) } },
                        onArchive = { scope.launch { onArchive(root.sessionId) } },
                    )
                    if (children.isNotEmpty()) {
                        val expanded = root.sessionId in expandedParents
                        ListItem(
                            headlineContent = {
                                Text(
                                    if (expanded) "▾ ${children.size} 个子会话" else "▸ ${children.size} 个子会话",
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            },
                            modifier = Modifier.clickable {
                                expandedParents = if (expanded) expandedParents - root.sessionId else expandedParents + root.sessionId
                            },
                        )
                        if (expanded) {
                            children.forEach { child ->
                                SessionRow(
                                    child,
                                    isSub = true,
                                    onClick = { onOpenSession(child) },
                                    onRename = { renameTarget = child },
                                    onFork = { scope.launch { onFork(child.sessionId) } },
                                    onArchive = { scope.launch { onArchive(child.sessionId) } },
                                )
                            }
                        }
                    }
                }
                // 归档区（默认折叠；归档会话仍可打开查看）
                if (archived.isNotEmpty()) {
                    item {
                        ListItem(
                            headlineContent = {
                                Text(
                                    if (showArchived) "▾ 归档 (${archived.size})" else "▸ 归档 (${archived.size})",
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            },
                            modifier = Modifier.clickable { showArchived = !showArchived },
                        )
                    }
                    if (showArchived) {
                        items(archived) { s ->
                            SessionRow(
                                s,
                                isSub = false,
                                onClick = { onOpenSession(s) },
                                onRename = { renameTarget = s },
                                onFork = { scope.launch { onFork(s.sessionId) } },
                                onArchive = null, // 已归档，无归档入口
                            )
                        }
                    }
                }
                item {
                    Button(onClick = { showDirPicker = true }, modifier = Modifier.fillMaxWidth().padding(16.dp)) {
                        Text("新建会话")
                    }
                }
            }
        }

        if (error != null) {
            Text(error, Modifier.padding(16.dp), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }
    }

    // 新建会话目录选择（工作区 / 远程目录浏览）
    if (showDirPicker) {
        DirectoryPickerDialog(
            onListWorkspaces = onListWorkspaces,
            onListDrives = onListDrives,
            onListDirectory = onListDirectory,
            onCreateFolder = onCreateFolder,
            onCreateAt = onCreateAt,
            onDismiss = { showDirPicker = false },
        )
    }

    // 删除设备条目确认弹窗（服务器吊销，所有端同步消失）
    deleteTarget?.let { target ->
        AlertDialog(
            onDismissRequest = { deleteTarget = null },
            title = { Text("删除设备条目") },
            text = {
                Text(
                    "将从你的账号中移除「${target.label}」，其他端也会同步消失。" +
                        "若这台电脑重新登录，会自动重新出现在列表中。",
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        scope.launch { onDeleteDevice(target) }
                        deleteTarget = null
                    },
                ) { Text("删除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { deleteTarget = null }) { Text("取消", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            },
        )
    }

    // 重命名弹窗
    renameTarget?.let { target ->
        var newTitle by remember(target.sessionId) { mutableStateOf(sessionTitleOf(target) ?: "") }
        AlertDialog(
            onDismissRequest = { renameTarget = null },
            title = { Text("重命名会话") },
            text = {
                OutlinedTextField(
                    value = newTitle,
                    onValueChange = { newTitle = it },
                    singleLine = true,
                    placeholder = { Text("输入会话名称") },
                    modifier = Modifier.fillMaxWidth(),
                )
            },
            confirmButton = {
                TextButton(
                    enabled = newTitle.isNotBlank(),
                    onClick = {
                        val title = newTitle.trim()
                        scope.launch {
                            if (onRename(target.sessionId, title) != null) renameTarget = null
                        }
                    },
                ) { Text("确定", color = MaterialTheme.colorScheme.primary) }
            },
            dismissButton = {
                TextButton(onClick = { renameTarget = null }) { Text("取消", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            },
        )
    }
}

@Composable
private fun SessionRow(
    session: SessionSummary,
    isSub: Boolean,
    onClick: () -> Unit,
    onRename: () -> Unit,
    onFork: () -> Unit,
    onArchive: (() -> Unit)?,
) {
    var menuOpen by remember { mutableStateOf(false) }
    val title = sessionTitleOf(session) ?: session.sessionId.take(13)
    ListItem(
        headlineContent = { Text((if (isSub) "└ " else "") + title, maxLines = 1, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurface) },
        supportingContent = {
            Text(
                buildString {
                    append(if (session.running) "● 运行中" else "空闲")
                    session.cwd?.let { append(" · $it") }
                    if (session.origin == "subagent") append(" · 子代理")
                },
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        },
        trailingContent = {
            Box {
                IconButton(onClick = { menuOpen = true }) {
                    Icon(Icons.Filled.MoreVert, "操作", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    DropdownMenuItem(text = { Text("重命名") }, onClick = { menuOpen = false; onRename() })
                    DropdownMenuItem(text = { Text("分叉会话") }, onClick = { menuOpen = false; onFork() })
                    if (onArchive != null) {
                        DropdownMenuItem(text = { Text("归档") }, onClick = { menuOpen = false; onArchive() })
                    }
                }
            }
        },
        modifier = Modifier.clickable(onClick = onClick),
    )
}

private fun sessionTree(sessions: List<SessionSummary>): List<Pair<SessionSummary, List<SessionSummary>>> {
    val children = sessions.filter { it.parentSessionId != null }.groupBy { it.parentSessionId!! }
    val roots = sessions.filter { it.parentSessionId == null }.sortedByDescending { it.updatedAt }
    return roots.map { it to (children[it.sessionId] ?: emptyList()) }
}
