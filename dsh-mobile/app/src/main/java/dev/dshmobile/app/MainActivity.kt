package dev.dshmobile.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.*
import androidx.compose.ui.graphics.Color
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import dev.dshmobile.app.net.HistoryEntry
import dev.dshmobile.app.net.RemoteEnvelope
import dev.dshmobile.app.net.RemoteStatus
import dev.dshmobile.app.screens.AuthScreen
import dev.dshmobile.app.screens.ConversationScreen
import dev.dshmobile.app.screens.NavigatorScreen
import dev.dshmobile.app.screens.PairLoginScreen
import dev.dshmobile.app.screens.sessionTitleOf
import dev.dshmobile.app.state.AppRepository
import dev.dshmobile.app.storage.TokenStore
import kotlinx.coroutines.launch
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

sealed interface Route {
    data object Auth : Route
    data object Navigator : Route
    data class Conversation(val sessionId: String, val title: String? = null) : Route
    /** 扫码登录：桌面出码后经 dshmobile://pair?relay=…&code=… 进入。 */
    data class PairLogin(val code: String, val relay: String? = null) : Route
}

class MainActivity : ComponentActivity() {

    private lateinit var repo: AppRepository

    /** deep link 触发的配对登录请求（onNewIntent/onCreate 写入，compose 消费）。 */
    private val pendingPairRoute = mutableStateOf<Route.PairLogin?>(null)

    private fun parsePairIntent(intent: Intent?): Route.PairLogin? {
        val data = intent?.data ?: return null
        if (data.scheme != "dshmobile" || data.host != "pair") return null
        val code = data.getQueryParameter("code")?.trim().orEmpty()
        if (code.isEmpty()) return null
        return Route.PairLogin(code, data.getQueryParameter("relay"))
    }

    /**
     * 解析相机扫码结果：仅接受自家落地页 URL（https://<relay>/dshmobile/?mode=…&code=…）。
     * 返回 (mode, code, relayOrigin)；非自家 URL 返回 null。
     */
    private fun parseScannedUrl(raw: String): Triple<String, String, String>? {
        val uri = runCatching { Uri.parse(raw.trim()) }.getOrNull() ?: return null
        if (uri.scheme !in listOf("https", "http")) return null
        if (!uri.path.orEmpty().contains("/dshmobile")) return null
        val mode = uri.getQueryParameter("mode") ?: "pair"
        val code = uri.getQueryParameter("code")?.trim().orEmpty()
        if (code.isEmpty()) return null
        val origin = buildString {
            append(uri.scheme).append("://").append(uri.host)
            if (uri.port != -1) append(":").append(uri.port)
        }
        return Triple(mode, code, origin)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        parsePairIntent(intent)?.let { pendingPairRoute.value = it }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        repo = AppRepository(
            cloudBaseUrl = "https://www.deepseek-claudex.cn",
            tokenStore = TokenStore(applicationContext),
        )
        lifecycleScope.launch { repo.restoreAuth() }
        parsePairIntent(intent)?.let { pendingPairRoute.value = it }

        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                var route by remember { mutableStateOf<Route>(Route.Auth) }
                val auth by repo.auth.collectAsState()
                val devices by repo.devices.collectAsState()
                val sessions by repo.sessions.collectAsState()
                val archivedIds by repo.archivedIds.collectAsState()
                val remoteStatus by repo.remoteStatus.collectAsState()
                val error by repo.error.collectAsState()
                val projections by repo.projections.collectAsState()

                // ---- 相机扫码（App 内扫码 → 直接分流，不进浏览器） ----
                val scanLauncher = rememberLauncherForActivityResult(ScanContract()) { result ->
                    val raw = result?.contents
                    if (raw == null) {
                        repo.setError(null)
                    } else {
                        val parsed = parseScannedUrl(raw)
                        when {
                            parsed == null -> repo.setError("无法识别的二维码：请扫描桌面端 DSH Mobile 卡片上的二维码")
                            parsed.first == "pair" -> route = Route.PairLogin(parsed.second, parsed.third)
                            parsed.first == "grant" -> repo.setError("「允许电脑登录」流程即将支持（S2），请先在 App 内登录账号")
                            else -> repo.setError("无法识别的二维码模式")
                        }
                    }
                }
                val permissionLauncher = rememberLauncherForActivityResult(
                    ActivityResultContracts.RequestPermission()
                ) { granted ->
                    if (granted) {
                        scanLauncher.launch(
                            ScanOptions()
                                .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                                .setOrientationLocked(false)
                                .setBeepEnabled(true)
                        )
                    } else {
                        repo.setError("需要相机权限才能扫码，请在系统设置中开启")
                    }
                }
                val startScan: () -> Unit = {
                    if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.CAMERA)
                        == PackageManager.PERMISSION_GRANTED
                    ) {
                        scanLauncher.launch(
                            ScanOptions()
                                .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                                .setOrientationLocked(false)
                                .setBeepEnabled(true)
                        )
                    } else {
                        permissionLauncher.launch(Manifest.permission.CAMERA)
                    }
                }

                // 登录状态驱动路由
                LaunchedEffect(auth) {
                    if (auth == null) {
                        route = Route.Auth
                    } else {
                        route = Route.Navigator
                        repo.refreshDevices()
                    }
                }

                // deep link 请求优先于登录态（消费后清空）。
                // 注意声明顺序必须在 LaunchedEffect(auth) 之后，避免首帧被覆盖。
                val pending = pendingPairRoute.value
                LaunchedEffect(pending) {
                    if (pending != null) {
                        route = pending
                        pendingPairRoute.value = null
                    }
                }

                // 设备连接后自动加载会话
                LaunchedEffect(remoteStatus) {
                    if (remoteStatus == RemoteStatus.CONNECTED) {
                        repo.loadSessions()
                    }
                }

                when (val r = route) {
                    is Route.Auth -> AuthScreen(
                        error = error,
                        onLogin = { u, p -> lifecycleScope.launch { runCatching { repo.login(u, p) }.onFailure { repoError(it) } } },
                        onRegister = { u, p -> lifecycleScope.launch { runCatching { repo.register(u, p) }.onFailure { repoError(it) } } },
                        onPairLogin = { code ->
                            lifecycleScope.launch {
                                runCatching { repo.loginWithPairingCode(code) }
                                    .onFailure { repoError(it) }
                            }
                        },
                        onScanRequest = startScan,
                    )
                    is Route.PairLogin -> PairLoginScreen(
                        code = r.code,
                        error = error,
                        onBack = { route = if (auth != null) Route.Navigator else Route.Auth },
                        onLogin = {
                            repo.setError(null)
                            r.relay?.takeIf { it.isNotBlank() }?.let { repo.cloudBaseUrl = it }
                            lifecycleScope.launch {
                                runCatching { repo.loginWithPairingCode(r.code) }
                                    .onFailure { repoError(it) }
                            }
                        },
                    )
                    is Route.Navigator -> NavigatorScreen(
                        devices = devices,
                        remoteStatus = remoteStatus,
                        sessions = sessions,
                        archivedIds = archivedIds,
                        error = error,
                        onSelectDevice = { repo.connectDevice(it.id) },
                        onRefreshDevices = { lifecycleScope.launch { repo.refreshDevices() } },
                        onLoadSessions = { lifecycleScope.launch { repo.loadSessions() } },
                        onOpenSession = { s -> route = Route.Conversation(s.sessionId, sessionTitleOf(s)) },
                        onListWorkspaces = { repo.listWorkspaces() },
                        onListDrives = { repo.listDrives() },
                        onListDirectory = { path -> repo.listDirectory(path) },
                        onCreateFolder = { path, name -> repo.createDirectory(path, name) != null },
                        onCreateAt = { cwd, ws ->
                            val sid = repo.createSession(cwd, ws)
                            if (sid != null) route = Route.Conversation(sid, "新会话")
                            sid != null
                        },
                        onRename = { sid, title -> repo.renameSession(sid, title) },
                        onFork = { sid -> repo.forkSession(sid) },
                        onArchive = { sid -> repo.archiveSession(sid) },
                        onDeleteDevice = { d -> lifecycleScope.launch { repo.revokeDevice(d.id) } },
                        onLogout = { repo.logout() },
                    )
                    is Route.Conversation -> ConversationScreen(
                        sessionId = r.sessionId,
                        sessionTitle = r.title,
                        events = repo.events,
                        remoteStatus = remoteStatus,
                        projections = projections,
                        onBack = { route = Route.Navigator },
                        onLoadHistory = { sid -> repo.sessionHistoryPage(sid, null, maxMessages = 20) },
                        onLoadOlder = { sid, before -> repo.sessionHistoryPage(sid, before, maxMessages = 50) },
                        onSubscribe = { sid -> repo.subscribeSession(sid) },
                        onSend = { sid, text -> repo.sendPrompt(sid, text) },
                        onInterrupt = { sid -> repo.interrupt(sid) },
                        onRename = { sid, title -> repo.renameSession(sid, title) },
                        onLoadModels = { sid -> repo.sessionModels(sid) },
                        onSelectModel = { sid, p, m, e -> repo.selectModel(sid, p, m, e) },
                        onSendCommand = { sid, cmd -> repo.sendCommand(sid, cmd) },
                        onSteer = { sid, text -> repo.steer(sid, text) },
                        onUpdateQueue = { sid, itemId, kind, text -> repo.updateQueue(sid, itemId, kind, text) },
                        onRespondApproval = { sid, aid, outcome, rpc -> repo.respondApproval(sid, aid, outcome, rpc) },
                        onRespondQuestion = { sid, answer, rpc -> repo.respondQuestion(sid, answer, rpc) },
                        onSkipQuestion = { sid, rpc -> repo.skipQuestion(sid, rpc) },
                        error = error,
                        onProjectionFrame = { frame ->
                            val key = frame["key"]?.jsonPrimitive?.contentOrNull ?: return@ConversationScreen
                            val value = frame["value"] ?: return@ConversationScreen
                            val seq = frame["seq"]?.jsonPrimitive?.contentOrNull?.toLongOrNull()
                            repo.updateProjection(key, value, seq)
                        },
                    )
                }
            }
        }
    }

    private fun repoError(e: Throwable) {
        repo.setError(e.message ?: "操作失败")
    }
}
