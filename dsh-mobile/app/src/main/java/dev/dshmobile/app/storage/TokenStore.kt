package dev.dshmobile.app.storage

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import dev.dshmobile.app.net.AuthSession
import kotlinx.serialization.json.Json

/** access/refresh token 安全存储（Keystore 加密）。会话数据不落盘。 */
class TokenStore(context: Context) {
    private val json = Json { ignoreUnknownKeys = true }
    private val prefs: SharedPreferences = run {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "dsh_auth",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    fun save(session: AuthSession) {
        prefs.edit().putString("session", json.encodeToString(AuthSession.serializer(), session)).apply()
    }

    fun load(): AuthSession? {
        val raw = prefs.getString("session", null) ?: return null
        return try { json.decodeFromString(AuthSession.serializer(), raw) } catch (_: Exception) { null }
    }

    fun clear() {
        prefs.edit().remove("session").apply()
    }
}
