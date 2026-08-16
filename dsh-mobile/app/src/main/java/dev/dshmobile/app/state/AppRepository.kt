package dev.dshmobile.app.state

import dev.dshmobile.app.net.AuthSession
import dev.dshmobile.app.net.CloudApi
import dev.dshmobile.app.net.DeviceSummary
import dev.dshmobile.app.net.RemoteClient
import dev.dshmobile.app.net.RemoteEnvelope
import dev.dshmobile.app.net.RemoteStatus
import dev.dshmobile.app.net.SessionSummary
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** 单一状态仓库：内存态（无会话数据落盘），退出即弃。 */
class AppRepository(
    var cloudBaseUrl: String,
    private val tokenStore: dev.dshmobile.app.storage.TokenStore,
) {
    private val json = Json { ignoreUnknownKeys = true }

    private val _auth = MutableStateFlow<AuthSession?>(null)
    val auth: StateFlow<AuthSession?> = _auth.asStateFlow()

    private val _devices = MutableStateFlow<List<DeviceSummary>>(emptyList())
    val devices: StateFlow<List<DeviceSummary>> = _devices.asStateFlow()

    private val _sessions = MutableStateFlow<List<SessionSummary>>(emptyList())
    val sessions: StateFlow<List<SessionSummary>> = _sessions.asStateFlow()

    /** 归档会话 id 集合（bridge sessions.list 附带 / host 事件更新）。 */
    private val _archivedIds = MutableStateFlow<Set<String>>(emptySet())
    val archivedIds: StateFlow<Set<String>> = _archivedIds.asStateFlow()

    private val _projections = MutableStateFlow<dev.dshmobile.app.net.ProjectionsBlock?>(null)
    val projections: StateFlow<dev.dshmobile.app.net.ProjectionsBlock?> = _projections.asStateFlow()

    private val _remoteStatus = MutableStateFlow(RemoteStatus.DISCONNECTED)
    val remoteStatus: StateFlow<RemoteStatus> = _remoteStatus.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    fun setError(message: String?) {
        _error.value = message
    }

    /** 实时投影更新：mux session/projection 帧到达时合并进缓存。 */
    fun updateProjection(key: String, value: kotlinx.serialization.json.JsonElement, seq: Long?) {
        val current = _projections.value ?: return
        if (seq != null && current.asOfSeq > seq) return  // 旧帧丢弃
        val newValues = current.values.toMutableMap().apply { put(key, value) }
        _projections.value = current.copy(asOfSeq = seq ?: current.asOfSeq, values = kotlinx.serialization.json.JsonObject(newValues))
    }

    var remote: RemoteClient? = null
        private set

    val events: SharedFlow<RemoteEnvelope>?
        get() = remote?.events

    val selectedDevice: DeviceSummary?
        get() = devices.value.firstOrNull { it.id == selectedDeviceId }

    var selectedDeviceId: String? = null
        private set

    suspend fun restoreAuth() {
        val stored = tokenStore.load() ?: return
        _auth.value = stored
        cloudBaseUrl = stored.cloudBaseUrl
        refreshDevices()
    }

    suspend fun login(username: String, password: String) {
        withContext(Dispatchers.IO) {
            val session = CloudApi(cloudBaseUrl).login(username, password)
            _auth.value = session
            tokenStore.save(session)
        }
    }

    suspend fun register(username: String, password: String) {
        withContext(Dispatchers.IO) {
            val session = CloudApi(cloudBaseUrl).register(username, password)
            _auth.value = session
            tokenStore.save(session)
        }
    }

    /** 扫码登录（方向一）：凭一次性配对码核销会话（无登录态）。失败抛异常由 UI 展示。 */
    suspend fun loginWithPairingCode(code: String) {
        withContext(Dispatchers.IO) {
            val session = CloudApi(cloudBaseUrl).verifyPairingCode(code)
            _auth.value = session
            tokenStore.save(session)
        }
    }

    /** 授权（方向二）：手机已登录，允许桌面插件登录本账号。失败抛异常由 UI 展示。 */
    suspend fun grantDeviceLogin(pairingId: String) {
        val session = _auth.value ?: throw IllegalStateException("请先登录账号，再授权电脑")
        withContext(Dispatchers.IO) {
            CloudApi(cloudBaseUrl).grantPairing(session.accessToken, pairingId)
        }
    }

    fun logout() {
        remote?.disconnect()
        remote = null
        _devices.value = emptyList()
        _sessions.value = emptyList()
        _auth.value = null
        selectedDeviceId = null
        tokenStore.clear()
    }

    suspend fun refreshDevices() {
        val session = _auth.value ?: return
        try {
            _devices.value = withContext(Dispatchers.IO) {
                CloudApi(cloudBaseUrl).devices(session.accessToken)
            }
        } catch (e: Exception) {
            setError("设备列表失败: ${e.message}")
        }
    }

    /** 删除设备条目 = 服务器吊销（软删除）。误删不丢：
     *  电脑端 bridge 重新注册（同 clientDeviceKey）会自动以新行回到列表。 */
    suspend fun revokeDevice(deviceId: String): Boolean {
        val session = _auth.value ?: return false
        return try {
            withContext(Dispatchers.IO) {
                CloudApi(cloudBaseUrl).revokeDevice(session.accessToken, deviceId)
            }
            refreshDevices()
            true
        } catch (e: Exception) {
            setError("删除失败: ${e.message}")
            false
        }
    }

    fun connectDevice(deviceId: String) {
        val session = _auth.value ?: return
        selectedDeviceId = deviceId
        remote?.disconnect()
        val client = RemoteClient(
            cloudBaseUrl = cloudBaseUrl,
            deviceId = deviceId,
            accessToken = { _auth.value?.accessToken ?: "" },
            refreshAccessToken = {
                val (at, rt) = CloudApi(cloudBaseUrl).refresh(_auth.value?.refreshToken ?: "")
                val updated = _auth.value!!.copy(accessToken = at, refreshToken = rt)
                _auth.value = updated
                tokenStore.save(updated)
                at
            },
        )
        remote = client
        client.connect()
        observeRemoteStatus(client)
    }

    /** 把 RemoteClient 状态流同步到仓库（协程收集）。 */
    private fun observeRemoteStatus(client: RemoteClient) {
        GlobalScope.launch(Dispatchers.Main.immediate) {
            client.status.collect { _remoteStatus.value = it }
        }
    }

    // ---------- 业务请求封装 ----------

    suspend fun loadSessions(): Boolean {
        val client = remote ?: return false
        val resp = client.request("sessions.list")
        val payload = resp.payload?.jsonObject ?: return false
        if (payload["ok"]?.jsonPrimitive?.contentOrNull != "true") return false
        val data = payload["data"]?.jsonObject ?: return false
        val arr = data["sessions"]?.jsonArray ?: return false
        _sessions.value = arr.map { json.decodeFromJsonElement(SessionSummary.serializer(), it) }
        data["archivedSessionIds"]?.jsonArray?.let { ids ->
            _archivedIds.value = ids.mapNotNull { it.jsonPrimitive?.contentOrNull }.toSet()
        }
        return true
    }

    /** 会话重命名：返回 DSH 归一化后的新标题，失败返回 null。 */
    suspend fun renameSession(sessionId: String, title: String): String? {
        val client = remote ?: return null
        val resp = client.request("sessions.rename", buildJsonObject {
            put("sessionId", sessionId)
            put("title", title)
        })
        val payload = resp.payload?.jsonObject ?: return null
        if (payload["ok"]?.jsonPrimitive?.contentOrNull != "true") {
            setError("重命名失败: ${payload["error"]?.jsonObject?.get("message")?.jsonPrimitive?.contentOrNull}")
            return null
        }
        loadSessions()
        return payload["data"]?.jsonObject?.get("title")?.jsonPrimitive?.contentOrNull
    }

    /** 分叉会话（在最后完成的轮次处切出新会话）：返回子会话 id，失败返回 null。 */
    suspend fun forkSession(sessionId: String): String? {
        val client = remote ?: return null
        val resp = client.request("sessions.fork", buildJsonObject { put("sessionId", sessionId) })
        val payload = resp.payload?.jsonObject ?: return null
        if (payload["ok"]?.jsonPrimitive?.contentOrNull != "true") {
            setError("分叉失败: ${payload["error"]?.jsonObject?.get("message")?.jsonPrimitive?.contentOrNull}")
            return null
        }
        loadSessions()
        return payload["data"]?.jsonObject?.get("sessionId")?.jsonPrimitive?.contentOrNull
    }

    /** 归档会话（单向，DSH 无 unarchive API）。 */
    suspend fun archiveSession(sessionId: String): Boolean {
        val client = remote ?: return false
        val resp = client.request("sessions.archive", buildJsonObject { put("sessionId", sessionId) })
        val payload = resp.payload?.jsonObject ?: return false
        if (payload["ok"]?.jsonPrimitive?.contentOrNull != "true") {
            setError("归档失败: ${payload["error"]?.jsonObject?.get("message")?.jsonPrimitive?.contentOrNull}")
            return false
        }
        payload["data"]?.jsonObject?.get("archivedSessionIds")?.jsonArray?.let { ids ->
            _archivedIds.value = ids.mapNotNull { it.jsonPrimitive?.contentOrNull }.toSet()
        }
        loadSessions()
        return true
    }

    /** 一页会话历史：事件列表 + 是否还有更早的消息（分页游标用 beforeSeq）。 */
    data class HistoryPage(
        val entries: List<dev.dshmobile.app.net.HistoryEntry>,
        val hasMore: Boolean,
    )

    /**
     * 拉取一页会话历史。beforeSeq=null 取尾页（含投影块缓存）；否则取该 seq 之前的一页。
     * 参考 sessioncontrol 的 conversation.history：beforeKey + limit，返回 hasMoreBefore。
     */
    suspend fun sessionHistoryPage(
        sessionId: String,
        beforeSeq: Long? = null,
        maxMessages: Int = 50,
    ): HistoryPage {
        val client = remote ?: return HistoryPage(emptyList(), false)
        val resp = client.request("sessions.history", buildJsonObject {
            put("sessionId", sessionId)
            if (beforeSeq != null) put("beforeSeq", beforeSeq)
            put("maxMessages", maxMessages)
        })
        val payload = resp.payload?.jsonObject ?: return HistoryPage(emptyList(), false)
        if (payload["ok"]?.jsonPrimitive?.contentOrNull != "true") {
            setError("history 失败: ${payload["error"]?.jsonObject?.get("message")?.jsonPrimitive?.contentOrNull}")
            return HistoryPage(emptyList(), false)
        }
        val data = payload["data"]?.jsonObject ?: return HistoryPage(emptyList(), false)
        // 投影块缓存（只随尾页返回，beforeSeq 分页页不含投影）
        data["projections"]?.let { proj ->
            try {
                val block = json.decodeFromJsonElement(dev.dshmobile.app.net.ProjectionsBlock.serializer(), proj)
                _projections.value = block
            } catch (_: Exception) {}
        }
        val arr = data["events"]?.jsonArray ?: return HistoryPage(emptyList(), false)
        val hasMore = data["hasMore"]?.jsonPrimitive?.contentOrNull?.toBooleanStrictOrNull() == true
        val entries = arr.map { json.decodeFromJsonElement(dev.dshmobile.app.net.HistoryEntry.serializer(), it) }
        return HistoryPage(entries, hasMore)
    }

    /** 尾页历史（兼容旧调用）：默认 20 条。 */
    suspend fun sessionHistory(sessionId: String, maxMessages: Int = 20): List<dev.dshmobile.app.net.HistoryEntry> =
        sessionHistoryPage(sessionId, null, maxMessages).entries

    suspend fun subscribeSession(sessionId: String) {
        remote?.request("events.subscribe", buildJsonObject { put("sessionId", sessionId) })
    }

    suspend fun createSession(cwd: String? = null, workspaceId: String? = null): String? {
        val client = remote ?: return null
        val resp = client.request("sessions.create", buildJsonObject {
            if (workspaceId != null) put("workspaceId", workspaceId)
            else if (cwd != null) put("cwd", cwd)
        })
        val payload = resp.payload?.jsonObject ?: return null
        if (payload["ok"]?.jsonPrimitive?.contentOrNull != "true") {
            setError("创建会话失败: ${payload["error"]?.jsonObject?.get("message")?.jsonPrimitive?.contentOrNull}")
            return null
        }
        val sid = payload["data"]?.jsonObject?.get("sessionId")?.jsonPrimitive?.contentOrNull
        if (sid != null) loadSessions()
        return sid
    }

    /** 工作区列表（新建会话选目录）。 */
    suspend fun listWorkspaces(): List<dev.dshmobile.app.net.WorkspaceInfo> {
        val client = remote ?: return emptyList()
        val resp = client.request("workspace.list")
        val payload = resp.payload?.jsonObject ?: return emptyList()
        if (payload["ok"]?.jsonPrimitive?.contentOrNull != "true") {
            setError("工作区列表失败: ${payload["error"]?.jsonObject?.get("message")?.jsonPrimitive?.contentOrNull}")
            return emptyList()
        }
        val arr = payload["data"]?.jsonObject?.get("items")?.jsonArray ?: return emptyList()
        return arr.map { json.decodeFromJsonElement(dev.dshmobile.app.net.WorkspaceInfo.serializer(), it) }
    }

    /** 「此电脑」层级：电脑上存在的盘符列表（bridge 本机探测）。 */
    suspend fun listDrives(): List<String> {
        val client = remote ?: return emptyList()
        val resp = client.request("host.listDrives")
        val payload = resp.payload?.jsonObject ?: return emptyList()
        if (payload["ok"]?.jsonPrimitive?.contentOrNull != "true") {
            setError("盘符列表失败: ${payload["error"]?.jsonObject?.get("message")?.jsonPrimitive?.contentOrNull}")
            return emptyList()
        }
        return payload["data"]?.jsonObject?.get("drives")?.jsonArray
            ?.mapNotNull { it.jsonPrimitive?.contentOrNull } ?: emptyList()
    }

    /** 远程浏览电脑目录（path=null 列出 home）。 */
    suspend fun listDirectory(path: String?): dev.dshmobile.app.net.DirListing? {
        val client = remote ?: return null
        val resp = client.request("host.listDirectory", buildJsonObject { if (path != null) put("path", path) })
        val payload = resp.payload?.jsonObject ?: return null
        if (payload["ok"]?.jsonPrimitive?.contentOrNull != "true") {
            setError("浏览目录失败: ${payload["error"]?.jsonObject?.get("message")?.jsonPrimitive?.contentOrNull}")
            return null
        }
        return payload["data"]?.jsonObject?.let { json.decodeFromJsonElement(dev.dshmobile.app.net.DirListing.serializer(), it) }
    }

    /** 在电脑上新建文件夹，返回新路径。 */
    suspend fun createDirectory(path: String, name: String): String? {
        val client = remote ?: return null
        val resp = client.request("host.createDirectory", buildJsonObject {
            put("path", path)
            put("name", name)
        })
        val payload = resp.payload?.jsonObject ?: return null
        if (payload["ok"]?.jsonPrimitive?.contentOrNull != "true") {
            setError("新建文件夹失败: ${payload["error"]?.jsonObject?.get("message")?.jsonPrimitive?.contentOrNull}")
            return null
        }
        return payload["data"]?.jsonObject?.get("path")?.jsonPrimitive?.contentOrNull
    }

    suspend fun sendPrompt(sessionId: String, text: String): Boolean {
        val client = remote ?: return false
        val resp = client.request("sessions.run", buildJsonObject {
            put("sessionId", sessionId)
            put("content", json.encodeToJsonElement(
                kotlinx.serialization.builtins.ListSerializer(dev.dshmobile.app.net.UserContentBlock.serializer()),
                listOf(dev.dshmobile.app.net.UserContentBlock(type = "text", text = text)),
            ))
        })
        val payload = resp.payload?.jsonObject ?: return false
        if (payload["ok"]?.jsonPrimitive?.contentOrNull != "true") {
            setError("发送失败: ${payload["error"]?.jsonObject?.get("message")?.jsonPrimitive?.contentOrNull}")
            return false
        }
        return true
    }

    suspend fun interrupt(sessionId: String): Boolean {
        val client = remote ?: return false
        val resp = client.request("sessions.interrupt", buildJsonObject {
            put("sessionId", sessionId)
            put("reason", "mobile interrupt")
        })
        return resp.payload?.jsonObject?.get("ok")?.jsonPrimitive?.contentOrNull == "true"
    }

    /** P1：会话模型目录。 */    suspend fun sessionModels(sessionId: String): dev.dshmobile.app.net.ModelDirectory? {
        val client = remote ?: return null
        val resp = client.request("session.models", buildJsonObject { put("sessionId", sessionId) })
        val payload = resp.payload?.jsonObject ?: return null
        if (payload["ok"]?.jsonPrimitive?.contentOrNull != "true") {
            setError("模型目录失败: ${payload["error"]?.jsonObject?.get("message")?.jsonPrimitive?.contentOrNull}")
            return null
        }
        return try {
            json.decodeFromJsonElement(dev.dshmobile.app.net.ModelDirectory.serializer(), payload["data"]!!)
        } catch (_: Exception) { null }
    }

    /** P1：选择模型/思考强度。 */
    suspend fun selectModel(sessionId: String, provider: String, model: String, effort: String?): Boolean {
        val client = remote ?: return false
        val resp = client.request("session.selectModel", buildJsonObject {
            put("sessionId", sessionId)
            put("provider", provider)
            put("model", model)
            if (effort != null) put("reasoningEffort", effort)
        })
        val payload = resp.payload?.jsonObject ?: return false
        if (payload["ok"]?.jsonPrimitive?.contentOrNull != "true") {
            setError("切换模型失败: ${payload["error"]?.jsonObject?.get("message")?.jsonPrimitive?.contentOrNull}")
            return false
        }
        return true
    }

    /** P1：斜杠命令（/plan、/permission 等）——走 commands/execute 通道。 */
    suspend fun sendCommand(sessionId: String, command: String): Boolean {
        val client = remote ?: return false
        val resp = client.request("commands.execute", buildJsonObject {
            put("sessionId", sessionId)
            put("line", command)
        })
        val payload = resp.payload?.jsonObject ?: return false
        if (payload["ok"]?.jsonPrimitive?.contentOrNull != "true") {
            setError("命令失败: ${payload["error"]?.jsonObject?.get("message")?.jsonPrimitive?.contentOrNull}")
            return false
        }
        return true
    }

    /** P1：中途介入（steer）。 */
    suspend fun steer(sessionId: String, text: String): Boolean {
        val client = remote ?: return false
        val resp = client.request("sessions.steer", buildJsonObject {
            put("sessionId", sessionId)
            put("content", json.encodeToJsonElement(
                kotlinx.serialization.builtins.ListSerializer(dev.dshmobile.app.net.UserContentBlock.serializer()),
                listOf(dev.dshmobile.app.net.UserContentBlock(type = "text", text = text)),
            ))
        })
        val payload = resp.payload?.jsonObject ?: return false
        if (payload["ok"]?.jsonPrimitive?.contentOrNull != "true") {
            setError("介入失败: ${payload["error"]?.jsonObject?.get("message")?.jsonPrimitive?.contentOrNull}")
            return false
        }
        return true
    }

    /** P2：排队消息管理（web 端 updateQueue 语义）。kind = edit | remove | steer；edit 时 newText 为新文本。
     *  返回 null 表示成功，否则返回错误消息（供 UI 就地显示）。 */
    suspend fun updateQueue(sessionId: String, itemId: String, kind: String, newText: String? = null): String? {
        val client = remote ?: return "未连接"
        val resp = client.request("sessions.updateQueue", buildJsonObject {
            put("sessionId", sessionId)
            put("itemId", itemId)
            put("action", buildJsonObject {
                put("kind", kind)
                if (kind == "edit" && newText != null) {
                    put("content", json.encodeToJsonElement(
                        kotlinx.serialization.builtins.ListSerializer(dev.dshmobile.app.net.UserContentBlock.serializer()),
                        listOf(dev.dshmobile.app.net.UserContentBlock(type = "text", text = newText)),
                    ))
                }
            })
        })
        val payload = resp.payload?.jsonObject
        if (payload == null || payload["ok"]?.jsonPrimitive?.contentOrNull != "true") {
            val msg = payload?.get("error")?.jsonObject?.get("message")?.jsonPrimitive?.contentOrNull
                ?: "消息操作失败"
            setError(msg)
            return msg
        }
        return null
    }

    /** P1：审批应答。 */
    suspend fun respondApproval(sessionId: String, approvalId: String, outcome: String, rpcId: String): Boolean {
        val client = remote ?: return false
        val resp = client.request("approvals.respond", buildJsonObject {
            put("sessionId", sessionId)
            put("approvalId", approvalId)
            put("outcome", outcome)
            put("rpcId", rpcId)
        })
        val payload = resp.payload?.jsonObject ?: return false
        if (payload["ok"]?.jsonPrimitive?.contentOrNull != "true") {
            setError("审批应答失败: ${payload["error"]?.jsonObject?.get("message")?.jsonPrimitive?.contentOrNull}")
            return false
        }
        return true
    }

    /** P1：提问应答。 */
    suspend fun respondQuestion(sessionId: String, answer: dev.dshmobile.app.net.AskUserQuestionAnswer, rpcId: String): Boolean {
        val client = remote ?: return false
        val resp = client.request("questions.respond", buildJsonObject {
            put("sessionId", sessionId)
            put("answer", json.encodeToJsonElement(dev.dshmobile.app.net.AskUserQuestionAnswer.serializer(), answer))
            put("rpcId", rpcId)
        })
        val payload = resp.payload?.jsonObject ?: return false
        if (payload["ok"]?.jsonPrimitive?.contentOrNull != "true") {
            setError("提问应答失败: ${payload["error"]?.jsonObject?.get("message")?.jsonPrimitive?.contentOrNull}")
            return false
        }
        return true
    }

    /** P1：跳过提问（DSH 语义 = ok:false + cancelled）。 */
    suspend fun skipQuestion(sessionId: String, rpcId: String): Boolean {
        val client = remote ?: return false
        val resp = client.request("questions.respond", buildJsonObject {
            put("sessionId", sessionId)
            put("rpcId", rpcId)
            put("cancel", true)
        })
        val payload = resp.payload?.jsonObject ?: return false
        if (payload["ok"]?.jsonPrimitive?.contentOrNull != "true") {
            setError("跳过失败: ${payload["error"]?.jsonObject?.get("message")?.jsonPrimitive?.contentOrNull}")
            return false
        }
        return true
    }

    /** 会话树：主会话 + 折叠子代理。 */
    fun sessionTree(): List<Pair<SessionSummary, List<SessionSummary>>> {
        val all = sessions.value
        val children = all.filter { it.parentSessionId != null }.groupBy { it.parentSessionId!! }
        val roots = all.filter { it.parentSessionId == null }
            .sortedByDescending { it.updatedAt }
        return roots.map { it to (children[it.sessionId] ?: emptyList()) }
    }
}
