package dev.dshmobile.app.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.dshmobile.app.net.AskUserQuestionAnswer
import dev.dshmobile.app.net.AskUserQuestionAnswerItem
import dev.dshmobile.app.net.HistoryEntry
import dev.dshmobile.app.net.ModelDirectory
import dev.dshmobile.app.net.ProjectionsBlock
import dev.dshmobile.app.net.RemoteEnvelope
import dev.dshmobile.app.net.RemoteStatus
import dev.dshmobile.app.state.AppRepository
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** 渲染单元：user/assistant 气泡与工具卡。 */
sealed interface ChatItem {
    /** queueId != null 表示该消息仍在 agent 收件箱中排队（placement: queued=排队中 / steering=引导中）。 */
    data class User(val text: String, val queueId: String? = null, val queuePlacement: String? = null) : ChatItem
    data class Assistant(val text: String) : ChatItem
    data class Tool(val name: String, val detail: String) : ChatItem
    data class Sys(val text: String) : ChatItem
}

/** 会话页：历史（尾部页 + 上滑分页）+ 流式事件 + 输入 + 中断 + P1 控制面。无状态：进入重拉，退出即弃。 */
@Composable
fun ConversationScreen(
    sessionId: String,
    sessionTitle: String?,
    events: SharedFlow<RemoteEnvelope>?,
    remoteStatus: RemoteStatus,
    projections: ProjectionsBlock?,
    onBack: () -> Unit,
    onLoadHistory: suspend (String) -> AppRepository.HistoryPage,
    onLoadOlder: suspend (String, Long?) -> AppRepository.HistoryPage,
    onSubscribe: suspend (String) -> Unit,
    onSend: suspend (String, String) -> Boolean,
    onInterrupt: suspend (String) -> Boolean,
    onRename: suspend (String, String) -> String?,
    onLoadModels: suspend (String) -> ModelDirectory?,
    onSelectModel: suspend (String, String, String, String?) -> Boolean,
    onSendCommand: suspend (String, String) -> Boolean,
    onSteer: suspend (String, String) -> Boolean,
    onUpdateQueue: suspend (String, String, String, String?) -> String?,
    onRespondApproval: suspend (String, String, String, String) -> Boolean,
    onRespondQuestion: suspend (String, AskUserQuestionAnswer, String) -> Boolean,
    onSkipQuestion: suspend (String, String) -> Boolean,
    onProjectionFrame: ((JsonObject) -> Unit)? = null,
    error: String? = null,
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var items by remember { mutableStateOf(listOf<ChatItem>()) }
    var input by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var running by remember { mutableStateOf(false) }
    var planActive by remember { mutableStateOf<Boolean?>(null) }
    val listState = rememberLazyListState()

    // 历史分页状态（参考 sessioncontrol：hasMoreBefore + loadingOlder 防重入 + beforeSeq 游标）
    var hasMoreOlder by remember { mutableStateOf(false) }
    var loadingOlder by remember { mutableStateOf(false) }
    var oldestSeq by remember { mutableStateOf<Long?>(null) }

    // 弹窗状态
    var showModelPicker by remember { mutableStateOf(false) }
    var showControls by remember { mutableStateOf(false) }
    var modelDirectory by remember { mutableStateOf<ModelDirectory?>(null) }
    // 会话标题（左上角显示；可点击重命名）
    var title by remember(sessionId) { mutableStateOf(sessionTitle) }
    var showRenameDialog by remember { mutableStateOf(false) }

    // 待应答的审批/提问（rpcId -> 数据）
    data class PendingApproval(val approvalId: String, val toolName: String, val reason: String?)
    var pendingApproval by remember { mutableStateOf<PendingApproval?>(null) }
    var pendingApprovalRpcId by remember { mutableStateOf<String?>(null) }
    var pendingQuestions by remember { mutableStateOf<List<PendingQuestionData>>(emptyList()) }

    // 收件箱（session/queue 帧）：queued=排队（显示在输入栏上方信息条），steering=引导中（会话流内 pending 气泡）
    data class QueueItemData(val id: String, val placement: String, val text: String)
    var pendingQueue by remember { mutableStateOf<List<QueueItemData>>(emptyList()) }
    // 编辑排队消息的目标（信息条「编辑」打开）
    var queueEditTarget by remember { mutableStateOf<ChatItem.User?>(null) }
    // 排队信息条展开/收起
    var dockExpanded by remember { mutableStateOf(true) }

    // 系统返回键 = 返回导航页
    BackHandler(onBack = onBack)

    // 事件流：session/event 帧 → 渲染（历史基线加载完成后收到的增量事件才追加，避免竞态）
    var historyLoaded by remember { mutableStateOf(false) }
    // 以某一页历史为基线重建消息列表，并同步分页游标（hasMoreOlder / oldestSeq）与运行/计划状态
    suspend fun rebuildFrom(page: AppRepository.HistoryPage, withHeader: Boolean) {
        items = (if (withHeader) listOf(ChatItem.Sys("会话 $sessionId")) else emptyList()) +
            page.entries.mapNotNull { entry -> toChatItem(entry) }
        hasMoreOlder = page.hasMore
        oldestSeq = page.entries.mapNotNull { it.seq }.minOrNull()
        planActive = page.entries.lastOrNull { it.event["type"]?.jsonPrimitive?.contentOrNull == "plan/mode" }
            ?.event?.get("data")?.jsonObject?.get("active")?.jsonPrimitive?.contentOrNull?.toBooleanStrictOrNull()
        // 从历史恢复运行状态（最后一个 turn/start|turn/end 决定）
        running = page.entries.lastOrNull { run ->
            val t = run.event["type"]?.jsonPrimitive?.contentOrNull
            t == "turn/start" || t == "turn/end"
        }?.event?.get("type")?.jsonPrimitive?.contentOrNull == "turn/start"
    }

    LaunchedEffect(sessionId) {
        historyLoaded = false
        val page = onLoadHistory(sessionId)
        rebuildFrom(page, withHeader = true)
        onSubscribe(sessionId)
        // 先滚到底部再放行分页触发：避免"打开瞬间在顶部"导致误拉一页
        listState.scrollToItem(items.lastIndex.coerceAtLeast(0))
        historyLoaded = true
    }

    // WS 断线重连后：重新订阅 + 重拉历史（补齐断线期间漏掉的事件；bridge 也会重放挂起提问/审批）
    var sawDisconnect by remember { mutableStateOf(false) }
    LaunchedEffect(remoteStatus) {
        when (remoteStatus) {
            RemoteStatus.RECONNECTING, RemoteStatus.DISCONNECTED, RemoteStatus.CONNECTING -> sawDisconnect = true
            RemoteStatus.CONNECTED -> {
                if (sawDisconnect) {
                    sawDisconnect = false
                    historyLoaded = false
                    val page = onLoadHistory(sessionId)
                    rebuildFrom(page, withHeader = false)
                    onSubscribe(sessionId)
                    listState.scrollToItem(items.lastIndex.coerceAtLeast(0))
                    historyLoaded = true
                }
            }
            RemoteStatus.AUTH_EXPIRED -> {}
        }
    }

    // 滑到最上方（无更早内容可滚）→ 拉取更早一页历史；列表短到填不满视口时自动补页
    // （参考 sessioncontrol：onEndReached + loadOlder，hasMoreOlder/loadingOlder 防重入）
    LaunchedEffect(listState, sessionId) {
        snapshotFlow {
            val idx = listState.firstVisibleItemIndex
            val offset = listState.firstVisibleItemScrollOffset
            listOf(idx == 0 && offset == 0, hasMoreOlder, loadingOlder, historyLoaded)
        }
            .collect { (atTop, more, loading, loaded) ->
                if (atTop && more && !loading && loaded) {
                    loadingOlder = true
                    try {
                        val page = onLoadOlder(sessionId, oldestSeq)
                        val older = page.entries.mapNotNull { entry -> toChatItem(entry) }
                        val newOldest = page.entries.mapNotNull { it.seq }.minOrNull()
                        if (older.isNotEmpty() && newOldest != null && newOldest != oldestSeq) {
                            items = older + items
                            // 保持视口位置：新页垫到顶部后，原第一项落在 index=older.size
                            if (listState.firstVisibleItemIndex <= 1) {
                                listState.requestScrollToItem(older.size, 0)
                            }
                            oldestSeq = newOldest
                            hasMoreOlder = page.hasMore
                        } else {
                            // 游标未前进（空页/重复页）：停，防死循环
                            hasMoreOlder = false
                        }
                    } catch (_: Exception) {
                        // 拉取失败：保持 hasMoreOlder，用户再次滑到顶部可重试
                    } finally {
                        loadingOlder = false
                    }
                }
            }
    }

    LaunchedEffect(events) {
        events?.collect { env ->
            if (!historyLoaded) return@collect
            if (env.type != "events.forward") return@collect
            val frame = env.payload?.jsonObject?.get("frame")?.jsonObject ?: return@collect
            val ftype = frame["type"]?.jsonPrimitive?.contentOrNull ?: return@collect
            if (frame["sessionId"]?.jsonPrimitive?.contentOrNull != sessionId) return@collect
            when (ftype) {
                "session/event" -> {
                    val event = frame["event"]?.jsonObject ?: return@collect
                    val etype = event["type"]?.jsonPrimitive?.contentOrNull ?: return@collect
                    val data = event["data"]?.jsonObject ?: return@collect
                    when (etype) {
                        "user/message" -> {
                            // DSH user/message: content 在 data.content（无 message 包装）。
                            // 聊天流中只保留「已接纳」的消息：引导中气泡 → 清标记；末尾同文本（历史重拉）→ 跳过；否则追加。
                            val text = textOf(data["content"])
                            if (text.isNotBlank()) {
                                val boundIdx = items.indexOfFirst { it is ChatItem.User && it.queueId != null && it.text == text }
                                when {
                                    boundIdx >= 0 -> {
                                        items = items.toMutableList().also { list ->
                                            list[boundIdx] = (list[boundIdx] as ChatItem.User).copy(queueId = null, queuePlacement = null)
                                        }
                                    }
                                    (items.lastOrNull { it is ChatItem.User } as? ChatItem.User)?.text == text -> {
                                        // 已上屏（历史重拉等），跳过
                                    }
                                    else -> {
                                        items = items + ChatItem.User(text)
                                    }
                                }
                            }
                        }
                        "assistant/message" -> {
                            val text = textOf(data["message"]?.jsonObject?.get("content"))
                            if (text.isNotBlank()) items = items + ChatItem.Assistant(text)
                        }
                        "tool/call" -> {
                            val name = data["name"]?.jsonPrimitive?.contentOrNull ?: "tool"
                            val args = data["arguments"]?.jsonPrimitive?.contentOrNull?.take(120) ?: ""
                            items = items + ChatItem.Tool(name, args)
                        }
                        "tool/result" -> {
                            val txt = textOf(data["message"]?.jsonObject?.get("content")).take(200)
                            if (txt.isNotBlank()) items = items + ChatItem.Tool("结果", txt)
                        }
                        "turn/start" -> { running = true }
                        "turn/end" -> { running = false }
                        else -> {}
                    }
                    listState.scrollToItem(items.lastIndex.coerceAtLeast(0))
                }
                "session/queue" -> {
                    // 收件箱快照：items[{id, placement: queued|steering|context, message}]。
                    // queued → 输入栏上方信息条；steering → 会话流内 ⚡引导中 pending 气泡（web 端 PendingSteeringBubble 语义）。
                    val itemsArr = frame["items"]?.jsonArray ?: emptyList()
                    val parsed = itemsArr.mapNotNull { it.jsonObject?.let { o ->
                        val id = o["id"]?.jsonPrimitive?.contentOrNull ?: return@let null
                        val placement = o["placement"]?.jsonPrimitive?.contentOrNull ?: "queued"
                        val text = textOf(o["message"]?.jsonObject?.get("content"))
                        QueueItemData(id, placement, text)
                    } }
                    pendingQueue = parsed
                    // 同步 steering 气泡：确保每条 steering 有一条带标记的气泡；已不在收件箱的清除标记
                    val steering = parsed.filter { it.placement == "steering" }
                    items = items.map { chat ->
                        if (chat is ChatItem.User && chat.queueId != null) {
                            val entry = steering.find { it.id == chat.queueId }
                            if (entry != null) chat.copy(queuePlacement = "steering")
                            else chat.copy(queueId = null, queuePlacement = null)
                        } else chat
                    }
                    for (entry in steering) {
                        // id 或文本已存在的气泡不再补（事件可能先清掉了标记，防止重影）
                        if (items.none { it is ChatItem.User && (it.queueId == entry.id || it.text == entry.text) }) {
                            items = items + ChatItem.User(entry.text, queueId = entry.id, queuePlacement = "steering")
                        }
                    }
                }
                "approval/requested" -> {
                    val approvalId = frame["approvalId"]?.jsonPrimitive?.contentOrNull ?: ""
                    val toolName = frame["toolName"]?.jsonPrimitive?.contentOrNull ?: ""
                    val reason = frame["reason"]?.jsonPrimitive?.contentOrNull
                    pendingApproval = PendingApproval(approvalId, toolName, reason)
                    pendingApprovalRpcId = env.payload?.jsonObject?.get("rpcId")?.jsonPrimitive?.contentOrNull
                    items = items + ChatItem.Sys("⏸ 等待审批: $toolName")
                }
                "approval/resolved" -> {
                    pendingApproval = null
                    pendingApprovalRpcId = null
                }
                "question/requested" -> {
                    val qs = frame["questions"]?.jsonArray?.mapNotNull { it.jsonObject } ?: emptyList()
                    val rpcId = env.payload?.jsonObject?.get("rpcId")?.jsonPrimitive?.contentOrNull ?: ""
                    if (qs.isNotEmpty()) pendingQuestions = pendingQuestions + PendingQuestionData(qs, rpcId)
                    items = items + ChatItem.Sys("❓ 提问待回答")
                }
                "question/resolved" -> {
                    pendingQuestions = emptyList()
                    items = items.filterNot { it is ChatItem.Sys && it.text == "❓ 提问待回答" }
                }
                "session/projection" -> {
                    // plan/mode 等投影：更新 planActive；stats 帧由 MainActivity 合并
                    frame["key"]?.jsonPrimitive?.contentOrNull?.let { key ->
                        if (key == "plan") {
                            val v = frame["value"]?.jsonObject
                            planActive = v?.get("active")?.jsonPrimitive?.contentOrNull?.toBooleanStrictOrNull()
                                ?: (v?.get("active")?.jsonPrimitive?.contentOrNull == "true")
                        }
                    }
                    onProjectionFrame?.invoke(frame)
                }
            }
        }
    }

    Column(Modifier.fillMaxSize().statusBarsPadding().imePadding()) {
        // 顶栏
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回", tint = MaterialTheme.colorScheme.onSurface)
            }
            Text(
                title ?: sessionId,
                style = MaterialTheme.typography.titleSmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.weight(1f).clickable { showRenameDialog = true },
            )
            // P1：模型选择
            TextButton(onClick = {
                showModelPicker = true
                scope.launch { modelDirectory = onLoadModels(sessionId) }
            }) {
                Text(
                    modelDirectory?.current?.model?.let { m -> m.take(14) } ?: "模型",
                    color = MaterialTheme.colorScheme.primary,
                    style = MaterialTheme.typography.labelMedium,
                    maxLines = 1,
                )
            }
            // P1：会话控制（计划模式/权限预设）
            IconButton(onClick = { showControls = true }) {
                Icon(Icons.Filled.Settings, "会话控制", tint = MaterialTheme.colorScheme.onSurface)
            }
            Text(
                if (running) "● 运行中" else "空闲",
                style = MaterialTheme.typography.bodySmall,
                color = if (running) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline,
            )
            IconButton(onClick = { scope.launch { onInterrupt(sessionId) } }, enabled = running) {
                Icon(Icons.Filled.Stop, "中断", tint = if (running) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f))
            }
        }
        HorizontalDivider()

        // 会话统计条（轮次/步数/时长/首token/缓存/上下文环）
        SessionStatsBar(projections)

        // 审批卡（agent 等待审批时显示）
        pendingApproval?.let { approval ->
            Surface(
                color = MaterialTheme.colorScheme.tertiaryContainer,
                shape = RoundedCornerShape(8.dp),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
            ) {
                Column(Modifier.padding(10.dp)) {
                    Text("⏸ 工具请求审批：${approval.toolName}", color = MaterialTheme.colorScheme.onTertiaryContainer, style = MaterialTheme.typography.titleSmall)
                    approval.reason?.takeIf { it.isNotBlank() }?.let {
                        Text(it, color = MaterialTheme.colorScheme.onTertiaryContainer, style = MaterialTheme.typography.bodySmall, maxLines = 3, overflow = TextOverflow.Ellipsis)
                    }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                        TextButton(onClick = {
                            val rpc = pendingApprovalRpcId
                            val aid = approval.approvalId
                            if (rpc != null) {
                                scope.launch { onRespondApproval(sessionId, aid, "rejected", rpc) }
                            }
                            pendingApproval = null; pendingApprovalRpcId = null
                        }) { Text("拒绝", color = MaterialTheme.colorScheme.error) }
                        TextButton(onClick = {
                            // 先把 rpcId 捕获进局部变量再进协程：onClick 随后会清空状态，读状态会竞态丢失
                            val rpc = pendingApprovalRpcId
                            val aid = approval.approvalId
                            if (rpc != null) {
                                scope.launch { onRespondApproval(sessionId, aid, "allowed-once", rpc) }
                            }
                            pendingApproval = null; pendingApprovalRpcId = null
                        }) { Text("允许一次", color = MaterialTheme.colorScheme.primary) }
                    }
                }
            }
        }

        // 消息列表
        LazyColumn(state = listState, modifier = Modifier.weight(1f), contentPadding = PaddingValues(12.dp)) {
            if (loadingOlder) {
                item(key = "loading-older") {
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 6.dp),
                        horizontalArrangement = Arrangement.Center,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.width(8.dp))
                        Text("加载更早的消息…", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.outline)
                    }
                }
            }
            items(items) { item ->
                when (item) {
                    is ChatItem.User -> Bubble(
                        item.text,
                        fromUser = true,
                        pendingLabel = if (item.queuePlacement == "steering") "⚡ 引导中" else null,
                        onLongClick = { copyToClipboard(context, item.text) },
                    )
                    is ChatItem.Assistant -> Bubble(
                        item.text,
                        fromUser = false,
                        onLongClick = { copyToClipboard(context, item.text) },
                    )
                    is ChatItem.Tool -> ToolCard(
                        item.name,
                        item.detail,
                        onLongClick = { copyToClipboard(context, listOf(item.name, item.detail).filter { it.isNotBlank() }.joinToString("\n")) },
                    )
                    is ChatItem.Sys -> Text(item.text, Modifier.padding(vertical = 6.dp), color = MaterialTheme.colorScheme.outline, style = MaterialTheme.typography.bodySmall)
                }
            }
        }

        // 排队信息条（web 端 QueueDock 语义）：贴在输入栏上方，不被会话流冲走；
        // 行内操作：编辑 / 删除 / 引导（插话发送，仅运行中）。
        val queuedItems = pendingQueue.filter { it.placement == "queued" }
        if (queuedItems.isNotEmpty()) {
            Surface(
                color = MaterialTheme.colorScheme.surfaceVariant,
                shape = RoundedCornerShape(topStart = 12.dp, topEnd = 12.dp),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
            ) {
                Column(Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {
                    Row(
                        Modifier.fillMaxWidth().clickable { dockExpanded = !dockExpanded }.padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            "排队消息 (${queuedItems.size})",
                            style = MaterialTheme.typography.labelLarge,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Spacer(Modifier.weight(1f))
                        Text(if (dockExpanded) "▾" else "▸", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (dockExpanded) {
                        HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.3f))
                        for (entry in queuedItems) {
                            Row(
                                Modifier.fillMaxWidth().padding(vertical = 6.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    entry.text,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurface,
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f),
                                )
                                TextButton(onClick = {
                                    queueEditTarget = ChatItem.User(entry.text, queueId = entry.id, queuePlacement = "queued")
                                }) { Text("编辑", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary) }
                                TextButton(onClick = {
                                    scope.launch { onUpdateQueue(sessionId, entry.id, "remove", null) }
                                }) { Text("删除", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error) }
                                if (running) {
                                    TextButton(onClick = {
                                        // 乐观更新：移出信息条、作为 ⚡引导中 气泡进会话流（web 端 steer 语义）
                                        pendingQueue = pendingQueue.map {
                                            if (it.id == entry.id) it.copy(placement = "steering") else it
                                        }
                                        if (items.none { it is ChatItem.User && it.queueId == entry.id }) {
                                            items = items + ChatItem.User(entry.text, queueId = entry.id, queuePlacement = "steering")
                                        }
                                        scope.launch { onUpdateQueue(sessionId, entry.id, "steer", null) }
                                    }) { Text("引导", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.tertiary) }
                                }
                            }
                        }
                    }
                }
            }
        }

        // 全局错误行（审批/消息操作等失败原因，此前不可见导致"点了没反应"）
        if (error != null) {
            Text(
                error,
                Modifier.padding(horizontal = 12.dp, vertical = 2.dp),
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }

        // 输入区：输入栏始终保留（web 端逻辑——运行中仍可发送，进入排队；点消息可 编辑/删除/引导，
        // 引导 = 插话自动插入对话）。运行中在发送旁放紧凑停止按钮，不再用大红按钮占掉输入栏。
        fun doSubmit() {
            val text = input.trim()
            if (text.isBlank() || sending) return
            input = ""
            sending = true
            scope.launch {
                // 排队中的消息由输入栏上方信息条（session/queue 帧）展示；被接纳后经 user/message 事件进入聊天流
                onSend(sessionId, text)
                sending = false
            }
        }
        Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = input,
                onValueChange = { input = it },
                placeholder = { Text("发消息…") },
                modifier = Modifier.weight(1f),
                maxLines = 4,
            )
            Spacer(Modifier.width(6.dp))
            if (running) {
                Button(
                    onClick = { doSubmit() },
                    enabled = input.isNotBlank() && !sending,
                    modifier = Modifier.height(48.dp),
                ) { Text("发送") }
                Spacer(Modifier.width(6.dp))
                IconButton(
                    onClick = { scope.launch { onInterrupt(sessionId) } },
                    modifier = Modifier.size(44.dp),
                ) {
                    Icon(Icons.Filled.Stop, "停止当前任务", tint = MaterialTheme.colorScheme.error)
                }
            } else {
                IconButton(
                    onClick = { doSubmit() },
                    enabled = input.isNotBlank() && !sending,
                ) {
                    Icon(
                        Icons.Filled.Send, "发送",
                        tint = if (input.isNotBlank() && !sending) MaterialTheme.colorScheme.primary
                        else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.4f),
                    )
                }
            }
        }
    }

    // 提问卡：ModalBottomSheet 从底部弹出
    val firstQuestion = pendingQuestions.firstOrNull()
    if (firstQuestion != null) {
        QuestionSheet(
            question = firstQuestion,
            onAnswer = { itemId, selected, custom ->
                val answer = AskUserQuestionAnswer(
                    answers = listOf(
                        AskUserQuestionAnswerItem(id = itemId, selected = selected, custom = custom)
                    )
                )
                scope.launch { onRespondQuestion(sessionId, answer, firstQuestion.rpcId) }
                pendingQuestions = pendingQuestions.drop(1)
            },
            onSkip = {
                scope.launch { onSkipQuestion(sessionId, firstQuestion.rpcId) }
                pendingQuestions = pendingQuestions.drop(1)
            },
            onDismiss = { /* 提问不可关闭（agent 等待应答），仅占位 */ },
        )
    }

    // 编辑排队消息（输入栏上方信息条的「编辑」打开；失败原因就地显示）
    queueEditTarget?.let { target ->
        var edited by remember(target.queueId) { mutableStateOf(target.text) }
        var editError by remember(target.queueId) { mutableStateOf<String?>(null) }
        AlertDialog(
            onDismissRequest = { queueEditTarget = null },
            title = { Text("编辑消息") },
            text = {
                Column {
                    OutlinedTextField(
                        value = edited,
                        onValueChange = {
                            edited = it
                            if (editError != null) editError = null
                        },
                        modifier = Modifier.fillMaxWidth(),
                        maxLines = 4,
                    )
                    if (editError != null) {
                        Spacer(Modifier.height(8.dp))
                        Text(
                            editError!!,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                }
            },
            confirmButton = {
                TextButton(
                    enabled = edited.isNotBlank(),
                    onClick = {
                        val newText = edited.trim()
                        scope.launch {
                            val err = onUpdateQueue(sessionId, target.queueId!!, "edit", newText)
                            if (err == null) {
                                items = items.map {
                                    if (it is ChatItem.User && it.queueId == target.queueId) it.copy(text = newText) else it
                                }
                                queueEditTarget = null
                            } else {
                                // 失败就地显示（如"该消息已被 agent 处理"），不再静默无反应
                                editError = err
                            }
                        }
                    },
                ) { Text("保存", color = MaterialTheme.colorScheme.primary) }
            },
            dismissButton = {
                TextButton(onClick = { queueEditTarget = null }) { Text("取消", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            },
        )
    }

    // 会话重命名弹窗（点顶栏标题触发）
    if (showRenameDialog) {
        var newTitle by remember { mutableStateOf(title ?: "") }
        AlertDialog(
            onDismissRequest = { showRenameDialog = false },
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
                        val t = newTitle.trim()
                        scope.launch {
                            val accepted = onRename(sessionId, t)
                            if (accepted != null) {
                                title = accepted
                                showRenameDialog = false
                            }
                        }
                    },
                ) { Text("确定", color = MaterialTheme.colorScheme.primary) }
            },
            dismissButton = {
                TextButton(onClick = { showRenameDialog = false }) { Text("取消", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            },
        )
    }

    // P1 弹窗
    if (showModelPicker) {
        modelDirectory?.let { dir ->
            ModelPickerDialog(
                directory = dir,
                onDismiss = { showModelPicker = false },
                onSelect = { p, m, e ->
                    scope.launch {
                        if (onSelectModel(sessionId, p, m, e)) {
                            modelDirectory = onLoadModels(sessionId)
                        }
                    }
                    showModelPicker = false
                },
            )
        }
    }
    if (showControls) {
        ControlSheet(
            planActive = planActive,
            onTogglePlan = { on ->
                scope.launch { onSendCommand(sessionId, if (on) "/plan" else "/plan off") }
                planActive = on
                showControls = false
            },
            onPreset = { preset ->
                scope.launch { onSendCommand(sessionId, "/permission $preset") }
                showControls = false
            },
            onDismiss = { showControls = false },
        )
    }
}

/** 提问底部弹窗：问题 + 选项 + 手动输入 + 跳过。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun QuestionSheet(
    question: PendingQuestionData,
    onAnswer: (itemId: String, selected: List<String>, custom: String?) -> Unit,
    onSkip: () -> Unit,
    onDismiss: () -> Unit,
) {
    var customText by remember { mutableStateOf("") }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(Modifier.padding(horizontal = 20.dp).padding(bottom = 28.dp)) {
            question.questions.forEach { item ->
                val itemId = item["id"]?.jsonPrimitive?.contentOrNull ?: ""
                val questionText = item["question"]?.jsonPrimitive?.contentOrNull ?: ""
                val header = item["header"]?.jsonPrimitive?.contentOrNull
                val detail = item["detail"]?.jsonPrimitive?.contentOrNull
                header?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary) }
                Text(questionText, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface)
                detail?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
                }
                Spacer(Modifier.height(12.dp))

                // 选项按钮（多选则每次提交单个选项的应答由 DSH 语义处理；单选项直接答）
                val options = item["options"]?.jsonArray.orEmpty()
                val multiSelect = item["multiSelect"]?.jsonPrimitive?.contentOrNull?.toBooleanStrictOrNull() == true
                var selected by remember(itemId) { mutableStateOf(listOf<String>()) }
                options.forEach { opt ->
                    val label = opt.jsonObject["label"]?.jsonPrimitive?.contentOrNull ?: ""
                    val desc = opt.jsonObject["description"]?.jsonPrimitive?.contentOrNull
                    val isSel = label in selected
                    OutlinedButton(
                        onClick = {
                            selected = if (multiSelect) {
                                if (isSel) selected - label else selected + label
                            } else listOf(label)
                            if (!multiSelect) onAnswer(itemId, listOf(label), null)
                        },
                        modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp),
                    ) {
                        Text(
                            (if (multiSelect && isSel) "✓ " else "") + label,
                            color = if (isSel) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                            maxLines = 2,
                        )
                    }
                    desc?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.outline)
                    }
                }
                if (multiSelect) {
                    Spacer(Modifier.height(6.dp))
                    Button(
                        onClick = { onAnswer(itemId, selected, null) },
                        enabled = selected.isNotEmpty(),
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("确认选择") }
                }
                Spacer(Modifier.height(12.dp))
            }

            // 手动输入
            OutlinedTextField(
                value = customText,
                onValueChange = { customText = it },
                placeholder = { Text("手动输入回答…") },
                modifier = Modifier.fillMaxWidth(),
                maxLines = 3,
            )
            Spacer(Modifier.height(8.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton(
                    onClick = onSkip,
                    modifier = Modifier.weight(1f),
                ) { Text("跳过本问题", color = MaterialTheme.colorScheme.error) }
                Button(
                    onClick = {
                        // 手动输入：取第一个问题 id，custom 文本（DSH 语义 custom 与 selected 互斥）
                        val first = question.questions.firstOrNull()
                        val itemId = first?.get("id")?.jsonPrimitive?.contentOrNull ?: ""
                        onAnswer(itemId, emptyList(), customText.ifBlank { null })
                    },
                    enabled = customText.isNotBlank(),
                    modifier = Modifier.weight(1f),
                ) { Text("提交输入") }
            }
        }
    }
}

/** 待应答提问数据（从帧提取）。 */
data class PendingQuestionData(
    val questions: List<JsonObject>,
    val rpcId: String,
)

/** 复制文本到系统剪贴板并 Toast 提示。 */
private fun copyToClipboard(context: Context, text: String) {
    if (text.isBlank()) return
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    cm.setPrimaryClip(ClipData.newPlainText("dsh-mobile", text))
    Toast.makeText(context, "已复制", Toast.LENGTH_SHORT).show()
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun Bubble(
    text: String,
    fromUser: Boolean,
    pendingLabel: String? = null,
    onClick: (() -> Unit)? = null,
    onLongClick: (() -> Unit)? = null,
) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 4.dp),
        horizontalArrangement = if (fromUser) Arrangement.End else Arrangement.Start,
    ) {
        Surface(
            color = if (fromUser) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
            shape = RoundedCornerShape(12.dp),
            modifier = Modifier.widthIn(max = 300.dp).let { m ->
                when {
                    onClick != null && onLongClick != null -> m.combinedClickable(onClick = onClick, onLongClick = onLongClick)
                    onClick != null -> m.clickable(onClick = onClick)
                    onLongClick != null -> m.combinedClickable(onClick = {}, onLongClick = onLongClick)
                    else -> m
                }
            },
        ) {
            Column(Modifier.padding(10.dp)) {
                Text(text)
                if (pendingLabel != null) {
                    Spacer(Modifier.height(4.dp))
                    Text(
                        pendingLabel,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ToolCard(name: String, detail: String, onLongClick: (() -> Unit)? = null) {
    Surface(
        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.5f),
        shape = RoundedCornerShape(8.dp),
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp).let { m ->
            if (onLongClick != null) m.combinedClickable(onClick = {}, onLongClick = onLongClick) else m
        },
    ) {
        Column(Modifier.padding(10.dp)) {
            Text("🔧 $name", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurface)
            if (detail.isNotBlank()) {
                Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.outline, maxLines = 4, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** 从 history entry 转渲染单元（跳过结构事件）。 */
private fun toChatItem(entry: HistoryEntry): ChatItem? {
    val event = entry.event
    val type = event["type"]?.jsonPrimitive?.contentOrNull ?: return null
    val data = event["data"]?.jsonObject
    return when (type) {
        // DSH user/message: content 在 data.content；assistant 在 data.message.content
        "user/message" -> textOf(data?.get("content")).takeIf { it.isNotBlank() }?.let { ChatItem.User(it) }
        "assistant/message" -> textOf(data?.get("message")?.jsonObject?.get("content")).takeIf { it.isNotBlank() }?.let { ChatItem.Assistant(it) }
        "tool/call" -> ChatItem.Tool(data?.get("name")?.jsonPrimitive?.contentOrNull ?: "tool", data?.get("arguments")?.jsonPrimitive?.contentOrNull?.take(120) ?: "")
        "tool/result" -> textOf(data?.get("message")?.jsonObject?.get("content")).take(200).takeIf { it.isNotBlank() }?.let { ChatItem.Tool("结果", it) }
        "turn/start" -> ChatItem.Sys("— 轮次开始 —")
        "turn/end" -> ChatItem.Sys("— 轮次结束 —")
        else -> null
    }
}

private fun textOf(content: kotlinx.serialization.json.JsonElement?): String =
    content?.jsonArray?.orEmpty()
        ?.mapNotNull { it.jsonObject["type"]?.jsonPrimitive?.contentOrNull to it.jsonObject["text"]?.jsonPrimitive?.contentOrNull }
        ?.filter { it.first == "text" }
        ?.joinToString("") { it.second ?: "" } ?: ""
