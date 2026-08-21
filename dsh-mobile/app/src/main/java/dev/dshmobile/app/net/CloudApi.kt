package dev.dshmobile.app.net

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/** relay REST 面：登录/注册/刷新/me/devices。契约见 docs/02-protocol.md §2.5。 */
class CloudApi(val baseUrl: String) {
    private val json = Json { ignoreUnknownKeys = true }
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private fun post(path: String, body: JsonObject, token: String? = null): JsonObject {
        val req = Request.Builder()
            .url(baseUrl + path)
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .apply { if (token != null) header("Authorization", "Bearer $token") }
            .build()
        client.newCall(req).execute().use { resp ->
            val text = resp.body?.string() ?: "{}"
            val obj = json.parseToJsonElement(text).jsonObject
            if (!resp.isSuccessful || obj["ok"]?.jsonPrimitive?.contentOrNull != "true") {
                throw CloudApiException(obj["error"]?.jsonObject?.get("message")?.jsonPrimitive?.contentOrNull ?: "HTTP ${resp.code}")
            }
            return obj
        }
    }

    private fun get(path: String, token: String): JsonObject {
        val req = Request.Builder()
            .url(baseUrl + path)
            .header("Authorization", "Bearer $token")
            .build()
        client.newCall(req).execute().use { resp ->
            val text = resp.body?.string() ?: "{}"
            val obj = json.parseToJsonElement(text).jsonObject
            if (!resp.isSuccessful || obj["ok"]?.jsonPrimitive?.contentOrNull != "true") {
                throw CloudApiException(obj["error"]?.jsonObject?.get("message")?.jsonPrimitive?.contentOrNull ?: "HTTP ${resp.code}")
            }
            return obj
        }
    }

    /** 登录。返回 AuthSession。 */
    fun login(username: String, password: String): AuthSession {
        val obj = post("/auth/login", buildJsonObject {
            put("username", username)
            put("password", password)
        })
        val data = obj["data"]!!.jsonObject
        return AuthSession(
            cloudBaseUrl = baseUrl,
            accessToken = data["accessToken"]!!.jsonPrimitive.content,
            refreshToken = data["refreshToken"]!!.jsonPrimitive.content,
            username = data["user"]?.jsonObject?.get("username")?.jsonPrimitive?.content ?: username,
            displayName = data["user"]?.jsonObject?.get("displayName")?.jsonPrimitive?.contentOrNull,
        )
    }

    fun register(username: String, password: String, displayName: String? = null): AuthSession {
        val obj = post("/auth/register", buildJsonObject {
            put("username", username)
            put("password", password)
            if (displayName != null) put("displayName", displayName)
        })
        // register 只返回 id/username；紧接着登录
        return login(username, password)
    }

    fun refresh(refreshToken: String): Pair<String, String> {
        val obj = post("/auth/refresh", buildJsonObject { put("refreshToken", refreshToken) })
        val data = obj["data"]!!.jsonObject
        return data["accessToken"]!!.jsonPrimitive.content to data["refreshToken"]!!.jsonPrimitive.content
    }

    fun devices(token: String): List<DeviceSummary> {
        val obj = get("/devices", token)
        val arr = obj["data"]?.jsonArray ?: return emptyList()
        return arr.map { json.decodeFromJsonElement(DeviceSummary.serializer(), it) }
    }

    /** 删除（吊销）设备：服务器端软删除，/devices 不再返回；
     *  电脑端重新注册（同 clientDeviceKey）会自动以新行复活。 */
    fun revokeDevice(token: String, deviceId: String) {
        post("/devices/$deviceId/revoke", buildJsonObject {}, token)
    }

    /** 扫码登录（方向一）：无登录态，凭一次性配对码核销换取账号会话。 */
    fun verifyPairingCode(code: String): AuthSession {
        val obj = post("/pairing-codes/verify", buildJsonObject { put("code", code) })
        val data = obj["data"]!!.jsonObject
        return AuthSession(
            cloudBaseUrl = baseUrl,
            accessToken = data["accessToken"]!!.jsonPrimitive.content,
            refreshToken = data["refreshToken"]!!.jsonPrimitive.content,
            username = data["user"]?.jsonObject?.get("username")?.jsonPrimitive?.content ?: "",
            displayName = data["user"]?.jsonObject?.get("displayName")?.jsonPrimitive?.contentOrNull,
        )
    }

    /** 授权（方向二）：手机已登录，把设备授权码绑定到本账号。 */
    fun grantPairing(token: String, pairingId: String) {
        post("/pairing-codes/$pairingId/grant", buildJsonObject {}, token)
    }

    // ---------- Data plane：文件传输（契约见 docs/02-protocol.md §7） ----------

    /** announce：幂等（同 用户+设备+fileId 返回原 transferId 续传）。 */
    fun announceTransfer(
        token: String,
        deviceId: String,
        fileId: String,
        name: String,
        size: Long,
        sha256: String,
        targetPath: String,
    ): TransferInfo {
        val obj = post(
            "/transfers",
            buildJsonObject {
                put("deviceId", deviceId)
                put("fileId", fileId)
                put("name", name)
                put("size", size)
                put("sha256", sha256)
                put("targetPath", targetPath)
            },
            token,
        )
        val data = obj["data"]!!.jsonObject
        return TransferInfo(
            transferId = data["transferId"]!!.jsonPrimitive.content,
            received = data["received"]?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: 0L,
            status = data["status"]?.jsonPrimitive?.contentOrNull ?: "uploading",
        )
    }

    /** 分块上传：offset 必须等于已收字节数，返回新的 received。 */
    fun putChunk(token: String, transferId: String, offset: Long, chunk: ByteArray): Long {
        val req = Request.Builder()
            .url("$baseUrl/transfers/${transferId}/chunks")
            .put(chunk.toRequestBody("application/octet-stream".toMediaType()))
            .header("Authorization", "Bearer $token")
            .header("X-Chunk-Offset", offset.toString())
            .build()
        client.newCall(req).execute().use { resp ->
            val text = resp.body?.string() ?: "{}"
            val obj = json.parseToJsonElement(text).jsonObject
            if (!resp.isSuccessful || obj["ok"]?.jsonPrimitive?.contentOrNull != "true") {
                throw CloudApiException(
                    obj["error"]?.jsonObject?.get("message")?.jsonPrimitive?.contentOrNull ?: "HTTP ${resp.code}",
                )
            }
            return obj["data"]?.jsonObject?.get("received")?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: 0L
        }
    }

    /** 收尾校验（size+sha256）→ ready → 控制面投递。返回状态。 */
    fun completeTransfer(token: String, transferId: String): String {
        val obj = post("/transfers/$transferId/complete", buildJsonObject {}, token)
        return obj["data"]?.jsonObject?.get("status")?.jsonPrimitive?.contentOrNull ?: "ready"
    }

    /** 状态查询。 */
    fun transferStatus(token: String, transferId: String): TransferStatus {
        val obj = get("/transfers/$transferId", token)
        val data = obj["data"]!!.jsonObject
        return TransferStatus(
            received = data["received"]?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: 0L,
            size = data["size"]?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: 0L,
            status = data["status"]?.jsonPrimitive?.contentOrNull ?: "unknown",
        )
    }

    /** 下载（Phase B：手机回显方向；用户 token owner 校验）。 */
    fun downloadTransfer(token: String, transferId: String): ByteArray {
        val req = Request.Builder()
            .url("$baseUrl/transfers/$transferId/download")
            .header("Authorization", "Bearer $token")
            .build()
        client.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) {
                throw CloudApiException("HTTP ${resp.code}")
            }
            return resp.body?.bytes() ?: ByteArray(0)
        }
    }
}

data class TransferInfo(val transferId: String, val received: Long, val status: String)

data class TransferStatus(val received: Long, val size: Long, val status: String)

class CloudApiException(message: String) : Exception(message)
