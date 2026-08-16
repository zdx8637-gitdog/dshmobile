package dev.dshmobile.app.net

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** relay canonical v1 信封。契约见 dsh-remote/docs/02-protocol.md §2。 */
@Serializable
data class RemoteEnvelope(
    val schemaVersion: JsonElement? = null,  // canonical=1(int)；legacy 帧为 "1.0.0"(string)
    val kind: String = "",                    // request | response | event | error | heartbeat（legacy 帧缺省为空）
    val type: String = "",
    val requestId: String? = null,
    val envelopeId: String? = null,
    val sentAt: String? = null,
    val actor: JsonObject? = null,
    val target: JsonObject? = null,
    val payload: JsonElement? = null,
)

/** 响应载荷：ok/data 或 ok:false/error。 */
@Serializable
data class RemoteResponsePayload(
    val ok: Boolean,
    val data: JsonElement? = null,
    val error: RemoteError? = null,
)

@Serializable
data class RemoteError(
    val code: String,
    val message: String,
    val retriable: Boolean? = null,
)

// ---------- 业务模型（与 bridge 输出一致） ----------

@Serializable
data class SessionSummary(
    val sessionId: String,
    val updatedAt: Long = 0,
    val running: Boolean = false,
    val blank: Boolean = false,
    val parentSessionId: String? = null,
    val origin: String? = null,
    val cwd: String? = null,
    val agentPreset: String? = null,
    val projections: SessionProjections? = null,
)

@Serializable
data class SessionProjections(
    val asOfSeq: Long = 0,
    val values: JsonObject? = null,
)

@Serializable
data class DeviceSummary(
    @SerialName("id") val id: String,
    val label: String,
    val platform: String? = null,
    val status: String,                     // online | offline | revoked
    val lastSeenAt: String? = null,
)

@Serializable
data class AuthSession(
    val cloudBaseUrl: String,
    val accessToken: String,
    val refreshToken: String,
    val username: String,
    val displayName: String? = null,
)

@Serializable
data class CloudUser(
    val id: String,
    val username: String,
)

/** DSH 会话事件（wire 投影后到达客户端）。 */
@Serializable
data class HistoryEntry(
    val seq: Long? = null,
    val event: JsonObject,
)

/** history 尾页投影块（sessionStats / tokenUsage / contextPressure / title / goal 等）。 */
@Serializable
data class ProjectionsBlock(
    val asOfSeq: Long = 0,
    val values: JsonObject = JsonObject(emptyMap()),
)

@Serializable
data class SessionStats(
    val turns: Int = 0,
    val steps: Int = 0,
    val llmMs: Long = 0,
    val toolMs: Long = 0,
    val ttftMs: Long = 0,
    val ttftSteps: Int = 0,
    val decodeMs: Long = 0,
    val decodeTokens: Long = 0,
)

@Serializable
data class TokenUsage(
    val uncachedInputTokens: Long = 0,
    val outputTokens: Long = 0,
    val cacheReadTokens: Long = 0,
    val cacheWriteTokens: Long = 0,
)

@Serializable
data class ContextPressure(
    val pressureTokens: Long = 0,
    val projectedTokens: Long = 0,
    val contextWindow: Long = 1,
)

/** 用户消息内容块（text/image）。 */
@Serializable
data class UserContentBlock(
    val type: String,                       // text | image
    val text: String? = null,
)

/** 工作区（新建会话选目录用）。 */
@Serializable
data class WorkspaceInfo(
    val workspaceId: String,
    val path: String,
    val title: String,
)

/** 目录条目（host.listDirectory 仅返回子目录）。 */
@Serializable
data class DirEntry(
    val name: String,
    val path: String,
)

/** 远程目录列表响应。 */
@Serializable
data class DirListing(
    val path: String = "",
    val home: String = "",
    val crumbs: List<DirEntry> = emptyList(),
    val entries: List<DirEntry> = emptyList(),
)

/** 提问应答（DSH AskUserQuestionAnswer）。 */
@Serializable
data class AskUserQuestionAnswer(
    val answers: List<AskUserQuestionAnswerItem>,
)

@Serializable
data class AskUserQuestionAnswerItem(
    val id: String,
    // DSH schema 要求 selected 必须存在（可为空数组）：kotlinx 默认省略默认值字段会 400
    @EncodeDefault
    val selected: List<String> = emptyList(),
    val custom: String? = null,
)
