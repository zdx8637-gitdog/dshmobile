package dev.dshmobile.app.util

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.ByteArrayOutputStream

/**
 * 图片压缩（Data plane 上传前）：长边压到 2048、JPEG q80——DeepSeek 视觉服务端会把
 * 图片缩至约 800×800 计 token（每图封顶 384 token），压到 2048 已足够保画质且省流量。
 * GIF 与损坏数据原样返回（不重编码）。
 */
fun compressImageIfNeeded(bytes: ByteArray, mime: String?, maxSide: Int = 2048, quality: Int = 80): ByteArray {
    if (mime == null || !mime.startsWith("image/")) return bytes
    if (mime == "image/gif") return bytes
    return try {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return bytes
        val longest = maxOf(bounds.outWidth, bounds.outHeight)
        if (longest <= maxSide) return bytes
        val sample = Integer.highestOneBit(longest / maxSide).coerceAtLeast(1)
        val opts = BitmapFactory.Options().apply { inSampleSize = sample }
        val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts) ?: return bytes
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, quality, out)
        bmp.recycle()
        out.toByteArray()
    } catch (_: Exception) {
        bytes
    }
}
