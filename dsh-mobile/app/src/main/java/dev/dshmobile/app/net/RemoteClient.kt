package dev.dshmobile.app.net

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.random.Random

enum class RemoteStatus { DISCONNECTED, CONNECTING, CONNECTED, RECONNECTING, AUTH_EXPIRED }

/**
 * relay /ws/client 客户端：自动重连、token 刷新、请求/响应归属、事件流。
 * 骨架移植自 sessioncontrol-ref/apps/mobile 的 RemoteClient（协议语义为 DSH）。
 */
class RemoteClient(
    private val cloudBaseUrl: String,
    private val deviceId: String,
    private val accessToken: () -> String,
    private val refreshAccessToken: suspend () -> String,
) {
    private val json = Json { ignoreUnknownKeys = true }
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)   // 长连接，禁用读超时
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var socket: WebSocket? = null
    private var reconnectJob: Job? = null
    private var closed = false   // disconnect 后禁止重连（退出登录/切换账号时的僵尸连接）
    private val pending = java.util.concurrent.ConcurrentHashMap<String, CompletableDeferred<RemoteEnvelope>>()

    private val _status = MutableStateFlow(RemoteStatus.DISCONNECTED)
    val status: StateFlow<RemoteStatus> = _status

    private val _events = MutableSharedFlow<RemoteEnvelope>(extraBufferCapacity = 256)
    val events: SharedFlow<RemoteEnvelope> = _events

    private val clientId = "android-" + Random.nextInt(0, Int.MAX_VALUE).toString(36)

    fun connect() {
        if (closed) return
        if (socket != null && (_status.value == RemoteStatus.CONNECTED || _status.value == RemoteStatus.CONNECTING)) return
        _status.value = RemoteStatus.CONNECTING
        val url = cloudBaseUrl.replaceFirst("https://", "wss://").replaceFirst("http://", "ws://") +
            "/ws/client?targetDeviceId=$deviceId&clientId=$clientId"
        val request = Request.Builder()
            .url(url)
            .header("Sec-WebSocket-Protocol", "bearer, ${accessToken()}")
            .build()
        socket = client.newWebSocket(request, listener)
    }

    fun disconnect() {
        closed = true
        reconnectJob?.cancel()
        socket?.close(1000, "client disconnect")
        socket = null
        _status.value = RemoteStatus.DISCONNECTED
    }

    /** 发请求并等待同 requestId 的响应（含重连后重发一次）。 */
    suspend fun request(type: String, payload: JsonObject = buildJsonObject {}): RemoteEnvelope {
        val requestId = "req-" + UUID.randomUUID().toString().replace("-", "").take(12)
        val deferred = CompletableDeferred<RemoteEnvelope>()
        pending[requestId] = deferred
        sendEnvelope(requestId, type, payload)
        // 等响应；若断线导致长时间无响应则返回离线错误
        return kotlinx.coroutines.withTimeoutOrNull(45_000) { deferred.await() }
            ?: run {
                pending.remove(requestId)
                offlineResponse(requestId, type)
            }
    }

    private fun sendEnvelope(requestId: String, type: String, payload: JsonObject) {
        val envelope = buildJsonObject {
            put("schemaVersion", 1)
            put("kind", "request")
            put("type", type)
            put("sentAt", java.time.Instant.now().toString())
            put("requestId", requestId)
            put("actor", buildJsonObject {
                put("role", "client")
                put("clientId", clientId)
            })
            put("target", buildJsonObject { put("deviceId", deviceId) })
            put("payload", payload)
        }
        socket?.send(envelope.toString())
    }

    private fun offlineResponse(requestId: String, type: String): RemoteEnvelope =
        RemoteEnvelope(
            kind = "error", type = type, requestId = requestId,
            payload = json.encodeToJsonElement(
                RemoteResponsePayload.serializer(),
                RemoteResponsePayload(
                    ok = false,
                    error = RemoteError(code = "OFFLINE", message = "relay 连接不可用", retriable = true),
                )
            ),
        )

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            _status.value = RemoteStatus.CONNECTED
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val env = try { json.decodeFromString<RemoteEnvelope>(text) } catch (_: Exception) { return }
            android.util.Log.d("RemoteClient", "msg kind=${env.kind} type=${env.type} len=${text.length}")
            when (env.kind) {
                "response", "error" -> {
                    env.requestId?.let { id ->
                        pending.remove(id)?.complete(env)
                    }
                }
                "event" -> scope.launch { _events.emit(env) }
                else -> {}
            }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            socket = null
            scheduleReconnect()
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            socket = null
            if (response?.code == 401 || t.message?.contains("401") == true) {
                scope.launch {
                    try { refreshAccessToken() } catch (_: Exception) {}
                    _status.value = RemoteStatus.AUTH_EXPIRED
                }
            } else {
                scheduleReconnect()
            }
        }
    }

    private fun scheduleReconnect() {
        if (closed) return
        if (_status.value == RemoteStatus.RECONNECTING) return
        _status.value = RemoteStatus.RECONNECTING
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            var attempt = 0
            while (true) {
                attempt++
                val backoff = minOf(30_000L, 1_000L shl minOf(attempt, 5))
                delay(backoff)
                connect()
                break
            }
        }
    }
}
