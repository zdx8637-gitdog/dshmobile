package dev.dshmobile.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.*
import androidx.compose.ui.graphics.Color
import androidx.lifecycle.lifecycleScope
import dev.dshmobile.app.net.HistoryEntry
import dev.dshmobile.app.net.RemoteEnvelope
import dev.dshmobile.app.net.RemoteStatus
import dev.dshmobile.app.screens.AuthScreen
import dev.dshmobile.app.screens.ConversationScreen
import dev.dshmobile.app.screens.NavigatorScreen
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
}

class MainActivity : ComponentActivity() {

    private lateinit var repo: AppRepository

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        repo = AppRepository(
            cloudBaseUrl = "https://www.deepseek-claudex.cn",
            tokenStore = TokenStore(applicationContext),
        )
        lifecycleScope.launch { repo.restoreAuth() }

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

                // 登录状态驱动路由
                LaunchedEffect(auth) {
                    if (auth == null) {
                        route = Route.Auth
                    } else {
                        route = Route.Navigator
                        repo.refreshDevices()
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
