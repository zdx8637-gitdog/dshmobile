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
import kotlinx.coroutines.delay
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
import java.security.MessageDigest

/** 归一化 relay 地址为 scheme://host[:port]（忽略路径/尾部斜杠/大小写），用于跨服务器比较。 */
internal fun normalizeRelayOrigin(url: String): String {
    val s = url.trim().trimEnd('/')
    return try {
        val u = java.net.URI(s)
        val scheme = (u.scheme ?: "https").lowercase()
        val host = (u.host ?: "").lowercase()
        if (host.isEmpty()) {
            s.lowercase()
        } else {
            val port = if (u.port > 0) ":${u.port}" else ""
            "$scheme://$host$port"
        }
    } catch (_: Exception) {
        s.lowercase()
    }
}

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

    /** 上传进度：received → total；null = 无上传。 */
    private val _uploadProgress = MutableStateFlow<Pair<Long, Long>?>(null)
    val uploadProgress: StateFlow<Pair<Long, Long>?> = _uploadProgress.asStateFlow()

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

    /**
     * 授权（方向二）：手机已登录，允许桌面插件登录本账号。失败抛异常由 UI 展示。
     * expectedRelay = 二维码携带的 relay 域名。与当前会话的服务器不一致时直接拒绝——
     * 防止恶意二维码/网页把登录令牌发往任意域名（token exfil）。
     */
    suspend fun grantDeviceLogin(pairingId: String, expectedRelay: String? = null) {
        val session = _auth.value ?: throw IllegalStateException("请先登录账号，再授权电脑")
        if (!expectedRelay.isNullOrBlank()) {
            val pinned = normalizeRelayOrigin(session.cloudBaseUrl)
            val target = normalizeRelayOrigin(expectedRelay)
            if (target != pinned) {
                throw IllegalStateException(
                    "该二维码来自其他服务器，与当前登录的服务器不一致，已拒绝发送登录凭证",
                )
            }
        }
        withContext(Dispatchers.IO) {
            withFreshToken { CloudApi(cloudBaseUrl).grantPairing(it, pairingId) }
        }
    }

    /**
     * 带自动刷新的 REST 调用：access token 过期时用 refresh token 换新并重试一次。
     * 刷新失败则把原异常抛给调用方（一般意味着会话不可恢复）。
     */
    private suspend fun <T> withFreshToken(block: (String) -> T): T {
        val session = _auth.value ?: throw IllegalStateException("未登录")
        return try {
            block(session.accessToken)
        } catch (e: Exception) {
            val msg = e.message ?: ""
            val authish = msg.contains("expired", ignoreCase = true) ||
                msg.contains("invalid", ignoreCase = true) ||
                msg.contains("unauthorized", ignoreCase = true) ||
                msg.contains("token", ignoreCase = true)
            if (!authish) throw e
            val (at, rt) = CloudApi(cloudBaseUrl).refresh(session.refreshToken)
            val updated = session.copy(accessToken = at, refreshToken = rt)
            _auth.value = updated
            tokenStore.save(updated)
            block(at)
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
                withFreshToken { CloudApi(cloudBaseUrl).devices(it) }
            }
            setError(null)
        } catch (e: Exception) {
            val msg = e.message ?: ""
            val authish = msg.contains("expired", ignoreCase = true) ||
                msg.contains("invalid", ignoreCase = true) ||
                msg.contains("unauthorized", ignoreCase = true) ||
                msg.contains("token", ignoreCase = true)
            if (authish) {
                // access 与 refresh 都已失效：会话不可恢复，回登录页重新扫码
                logout()
                setError("登录已过期，请重新扫码登录")
            } else {
                setError("设备列表失败: $msg")
            }
        }
    }

    /** 删除设备条目 = 服务器吊销（软删除）。误删不丢：
     *  电脑端 bridge 重新注册（同 clientDeviceKey）会自动以新行回到列表。 */
    suspend fun revokeDevice(deviceId: String): Boolean {
        if (_auth.value == null) return false
        return try {
            withContext(Dispatchers.IO) {
                withFreshToken { CloudApi(cloudBaseUrl).revokeDevice(it, deviceId) }
            }
            refreshDevices()
            true
        } catch (e: Exception) {
            setError("删除失败: ${e.message}")
            false
        }
    }

    // ---------- Data plane：文件上传（手机 → PC，契约见 docs/02-protocol.md §7） ----------

    /**
     * 上传一个文件到设备并（可选）进会话。返回电脑上的落盘路径，失败抛异常。
     * 断点续传：offset 不匹配时以同 fileId 幂等重 announce 续传。
     */
    suspend fun uploadFile(
        deviceId: String,
        sessionId: String?,
        name: String,
        targetPath: String,
        bytes: ByteArray,
    ): String {
        val session = _auth.value ?: throw IllegalStateException("未登录")
        if (bytes.isEmpty()) throw IllegalStateException("空文件")
        val sha = MessageDigest.getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }
        val api = CloudApi(cloudBaseUrl)
        _uploadProgress.value = 0L to bytes.size.toLong()
        try {
            var info = withContext(Dispatchers.IO) {
                api.announceTransfer(session.accessToken, deviceId, sha, name, bytes.size.toLong(), sha, targetPath)
            }
            var offset = info.received.coerceAtMost(bytes.size.toLong())
            val chunkSize = 512 * 1024
            while (offset < bytes.size) {
                val end = minOf(offset + chunkSize, bytes.size.toLong()).toInt()
                val chunk = bytes.copyOfRange(offset.toInt(), end)
                try {
                    val received = withContext(Dispatchers.IO) {
                        api.putChunk(session.accessToken, info.transferId, offset, chunk)
                    }
                    offset = received
                    _uploadProgress.value = offset to bytes.size.toLong()
                } catch (e: Exception) {
                    val msg = e.message ?: ""
                    if (msg.contains("offset", ignoreCase = true) || msg.contains("NOT_FOUND", ignoreCase = true)) {
                        // spool 已清理/偏移失效：同 fileId 幂等重 announce 后续传
                        info = withContext(Dispatchers.IO) {
                            api.announceTransfer(session.accessToken, deviceId, sha, name, bytes.size.toLong(), sha, targetPath)
                        }
                        offset = info.received.coerceAtMost(bytes.size.toLong())
                    } else {
                        throw e
                    }
                }
            }
            withContext(Dispatchers.IO) { api.completeTransfer(session.accessToken, info.transferId) }
            // complete 后 relay 异步投递到 bridge：upload.commit 可能撞上 not-landed，轮询重试
            val client = remote ?: throw IllegalStateException("未连接设备")
            repeat(30) {
                val resp = client.request(
                    "upload.commit",
                    buildJsonObject {
                        put("transferId", info.transferId)
                        put("fileId", sha)
                        put("name", name)
                        put("size", bytes.size.toLong())
                        put("sha256", sha)
                        put("targetPath", targetPath)
                        if (sessionId != null) put("sessionId", sessionId)
                    },
                )
                val payload = resp.payload?.jsonObject
                if (payload?.get("ok")?.jsonPrimitive?.contentOrNull == "true") {
                    val path = payload["data"]?.jsonObject?.get("path")?.jsonPrimitive?.contentOrNull
                    // 会话提及失败（如 DSH 释放了会话）不再静默：展示出来
                    val notice = payload["data"]?.jsonObject?.get("noticeFailed")?.jsonPrimitive?.contentOrNull
                    if (!notice.isNullOrBlank()) {
                        setError("文件已上传，但会话提及失败：$notice")
                    }
                    if (path != null) return path
                } else {
                    val code = payload?.get("error")?.jsonObject?.get("code")?.jsonPrimitive?.contentOrNull
                    if (code != "not-landed" && code != "OFFLINE") {
                        throw IllegalStateException(
                            payload?.get("error")?.jsonObject?.get("message")?.jsonPrimitive?.contentOrNull
                                ?: "上传确认失败",
                        )
                    }
                }
                delay(1000)
            }
            throw IllegalStateException("上传确认超时：文件已传到电脑，但未能确认落盘")
        } finally {
            _uploadProgress.value = null
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

    /** 附件回显（Phase B）：桥代取 DSH 附件字节 → 反向传输 → 手机下载。返回图片字节。 */
    suspend fun resolveAttachment(sessionId: String, attachmentId: String): ByteArray {
        val client = remote ?: throw IllegalStateException("未连接设备")
        val resp = client.request(
            "attachment.resolve",
            buildJsonObject {
                put("sessionId", sessionId)
                put("attachmentId", attachmentId)
            },
        )
        val payload = resp.payload?.jsonObject
        if (payload?.get("ok")?.jsonPrimitive?.contentOrNull != "true") {
            throw IllegalStateException(
                payload?.get("error")?.jsonObject?.get("message")?.jsonPrimitive?.contentOrNull
                    ?: "图片获取失败",
            )
        }
        val transferId = payload["data"]?.jsonObject?.get("transferId")?.jsonPrimitive?.contentOrNull
            ?: throw IllegalStateException("transferId 缺失")
        val session = _auth.value ?: throw IllegalStateException("未登录")
        return withContext(Dispatchers.IO) {
            withFreshToken { CloudApi(cloudBaseUrl).downloadTransfer(it, transferId) }
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
