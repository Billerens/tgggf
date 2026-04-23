package com.tggf.app.localapi

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.os.Build
import android.util.Base64
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.content.ContextCompat
import com.tggf.app.MainActivity
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import kotlin.math.abs

object IncomingMessageNotificationManager {
    private const val CHANNEL_ID = "incoming_messages"
    private const val CHANNEL_NAME = "Входящие сообщения"
    private const val CHANNEL_DESCRIPTION = "Уведомления о входящих сообщениях чатов и групп"
    private const val GROUP_KEY = "tggf.incoming"
    private const val SUMMARY_NOTIFICATION_ID = 1_170_701
    private const val PREFS_NAME = "tg_gf_notifications"
    private const val PREF_SEEN_MESSAGE_IDS = "seen_message_ids"
    private const val MAX_SEEN_MESSAGE_IDS = 320
    private val dedupeLock = Any()

    @JvmStatic
    fun notifyIncomingChatMessage(
        context: Context,
        repository: LocalRepository,
        chat: JSONObject,
        persona: JSONObject?,
        message: JSONObject,
    ) {
        val chatId = chat.optString("id", "").trim()
        if (chatId.isBlank()) return
        if (!isNotificationsEnabled(chat)) return
        if (message.optString("role", "").trim().lowercase(Locale.US) != "assistant") {
            return
        }
        val messageId = message.optString("id", "").trim()
        val personaName =
            persona?.optString("name", "")?.trim().orEmpty().ifBlank {
                chat.optString("title", "").trim().ifBlank { "Персона" }
            }
        val avatarRef = resolvePersonaAvatarRef(persona)
        val previewText = normalizeMessagePreview(message.optString("content", ""))
        notifyIncoming(
            context = context,
            repository = repository,
            conversationKey = "chat:$chatId",
            targetType = "chat",
            targetId = chatId,
            conversationTitle = personaName,
            senderName = personaName,
            previewText = previewText,
            avatarRef = avatarRef,
            messageId = messageId,
            isGroupConversation = false,
        )
    }

    @JvmStatic
    fun notifyIncomingGroupMessage(
        context: Context,
        repository: LocalRepository,
        room: JSONObject,
        message: JSONObject,
    ) {
        val roomId = room.optString("id", "").trim()
        if (roomId.isBlank()) return
        if (!isNotificationsEnabled(room)) return
        if (message.optString("authorType", "").trim().lowercase(Locale.US) != "persona") {
            return
        }
        val messageId = message.optString("id", "").trim()
        val roomTitle = room.optString("title", "").trim().ifBlank { "Групповой чат" }
        val senderName =
            message
                .optString("authorDisplayName", "")
                .trim()
                .ifBlank { "Персона" }
        val avatarRef = message.optString("authorAvatarUrl", "").trim()
        val previewText = normalizeMessagePreview(message.optString("content", ""))
        notifyIncoming(
            context = context,
            repository = repository,
            conversationKey = "group:$roomId",
            targetType = "group",
            targetId = roomId,
            conversationTitle = roomTitle,
            senderName = senderName,
            previewText = previewText,
            avatarRef = avatarRef,
            messageId = messageId,
            isGroupConversation = true,
        )
    }

    private fun notifyIncoming(
        context: Context,
        repository: LocalRepository,
        conversationKey: String,
        targetType: String,
        targetId: String,
        conversationTitle: String,
        senderName: String,
        previewText: String,
        avatarRef: String,
        messageId: String,
        isGroupConversation: Boolean,
    ) {
        if (targetId.isBlank()) return
        if (messageId.isBlank()) return
        if (!canPostNotifications(context)) return
        if (MainActivity.isAppInForeground()) return
        if (isDuplicateMessage(context, messageId)) return

        val appContext = context.applicationContext
        ensureNotificationChannel(appContext)
        val manager = NotificationManagerCompat.from(appContext)
        val timestampMs = System.currentTimeMillis()
        val sender = Person.Builder().setName(senderName.ifBlank { "Персона" }).build()
        val me = Person.Builder().setName("Вы").build()
        val style =
            NotificationCompat.MessagingStyle(me)
                .setConversationTitle(conversationTitle.ifBlank { "Persona Chat" })
                .setGroupConversation(isGroupConversation)
                .addMessage(
                    if (previewText.isBlank()) "Новое сообщение" else previewText,
                    timestampMs,
                    sender,
                )

        val launchIntent = Intent(appContext, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("targetType", targetType)
            putExtra("targetId", targetId)
            putExtra("messageId", messageId)
        }
        val pendingIntent =
            PendingIntent.getActivity(
                appContext,
                stableNotificationId("${conversationKey}:${messageId}"),
                launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )

        val builder =
            NotificationCompat.Builder(appContext, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle(conversationTitle.ifBlank { senderName.ifBlank { "Persona Chat" } })
                .setContentText(if (previewText.isBlank()) "Новое сообщение" else previewText)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setShowWhen(true)
                .setWhen(timestampMs)
                .setContentIntent(pendingIntent)
                .setGroup(GROUP_KEY)
                .setStyle(style)

        resolveAvatarBitmap(repository, avatarRef, senderName)?.let { avatarBitmap ->
            builder.setLargeIcon(avatarBitmap)
        }

        val summaryBuilder =
            NotificationCompat.Builder(appContext, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle("Persona Chat")
                .setContentText("Новые сообщения")
                .setGroup(GROUP_KEY)
                .setGroupSummary(true)
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setStyle(
                    NotificationCompat.InboxStyle().setSummaryText("Входящие диалоги"),
                )

        try {
            manager.notify(stableNotificationId(conversationKey), builder.build())
            manager.notify(SUMMARY_NOTIFICATION_ID, summaryBuilder.build())
        } catch (_: SecurityException) {
            // Permission could be revoked while the job is running.
        }
    }

    private fun isNotificationsEnabled(entity: JSONObject): Boolean {
        if (!entity.has("notificationsEnabled")) return true
        return entity.optBoolean("notificationsEnabled", true)
    }

    private fun resolvePersonaAvatarRef(persona: JSONObject?): String {
        if (persona == null) return ""
        val avatarImageId = persona.optString("avatarImageId", "").trim()
        if (avatarImageId.isNotBlank()) {
            return "idb://$avatarImageId"
        }
        val avatarUrl = persona.optString("avatarUrl", "").trim()
        if (avatarUrl.isNotBlank()) return avatarUrl
        val fullBodyImageId = persona.optString("fullBodyImageId", "").trim()
        if (fullBodyImageId.isNotBlank()) {
            return "idb://$fullBodyImageId"
        }
        return persona.optString("fullBodyUrl", "").trim()
    }

    private fun normalizeMessagePreview(raw: String): String {
        val compact = raw.replace(Regex("\\s+"), " ").trim()
        if (compact.isBlank()) return ""
        return if (compact.length > 220) "${compact.take(219).trimEnd()}…" else compact
    }

    private fun canPostNotifications(context: Context): Boolean {
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                ContextCompat.checkSelfPermission(
                    context,
                    Manifest.permission.POST_NOTIFICATIONS,
                ) != PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    private fun ensureNotificationChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel =
            NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_HIGH)
                .apply {
                    description = CHANNEL_DESCRIPTION
                    setShowBadge(true)
                    lockscreenVisibility = Notification.VISIBILITY_PRIVATE
                }
        manager.createNotificationChannel(channel)
    }

    private fun stableNotificationId(key: String): Int {
        val raw = key.hashCode()
        val normalized = if (raw == Int.MIN_VALUE) Int.MAX_VALUE else abs(raw)
        return if (normalized == 0) 1 else normalized
    }

    private fun isDuplicateMessage(context: Context, messageId: String): Boolean {
        synchronized(dedupeLock) {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val raw = prefs.getString(PREF_SEEN_MESSAGE_IDS, "").orEmpty()
            val entries =
                raw
                    .split('\n')
                    .map { value -> value.trim() }
                    .filter { value -> value.isNotEmpty() }
                    .toMutableList()
            if (entries.contains(messageId)) {
                return true
            }
            entries.add(messageId)
            if (entries.size > MAX_SEEN_MESSAGE_IDS) {
                val overflow = entries.size - MAX_SEEN_MESSAGE_IDS
                repeat(overflow) {
                    if (entries.isNotEmpty()) {
                        entries.removeAt(0)
                    }
                }
            }
            prefs.edit().putString(PREF_SEEN_MESSAGE_IDS, entries.joinToString("\n")).apply()
            return false
        }
    }

    private fun resolveAvatarBitmap(
        repository: LocalRepository,
        avatarRef: String,
        fallbackName: String,
    ): Bitmap? {
        val normalizedRef = avatarRef.trim()
        if (normalizedRef.isNotBlank()) {
            if (normalizedRef.startsWith("idb://")) {
                val imageId = normalizedRef.removePrefix("idb://").trim()
                if (imageId.isNotEmpty()) {
                    decodeIdbImageAsset(repository, imageId)?.let { return it }
                }
            } else {
                decodeBitmapFromUrl(normalizedRef)?.let { return it }
            }
        }
        return createLetterAvatar(fallbackName.ifBlank { "?" })
    }

    private fun decodeIdbImageAsset(repository: LocalRepository, imageId: String): Bitmap? {
        val rawStore = repository.readStoreJson("imageAssets") ?: return null
        val assets =
            try {
                JSONArray(rawStore)
            } catch (_: Exception) {
                return null
            }
        for (index in 0 until assets.length()) {
            val item = assets.optJSONObject(index) ?: continue
            val id = item.optString("id", "").trim()
            if (id != imageId) continue
            val dataUrl = item.optString("dataUrl", "").trim()
            if (dataUrl.isBlank()) return null
            return decodeBitmapFromDataUrl(dataUrl)
        }
        return null
    }

    private fun decodeBitmapFromDataUrl(dataUrl: String): Bitmap? {
        val payload = dataUrl.substringAfter(',', "").trim()
        if (payload.isBlank()) return null
        return try {
            val bytes = Base64.decode(payload, Base64.DEFAULT)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        } catch (_: Exception) {
            null
        }
    }

    private fun decodeBitmapFromUrl(urlString: String): Bitmap? {
        return try {
            val connection = URL(urlString).openConnection() as? HttpURLConnection ?: return null
            connection.connectTimeout = 4_000
            connection.readTimeout = 4_000
            connection.instanceFollowRedirects = true
            connection.useCaches = true
            connection.doInput = true
            connection.connect()
            if (connection.responseCode !in 200..299) {
                connection.disconnect()
                return null
            }
            connection.inputStream.use { stream -> BitmapFactory.decodeStream(stream) }
        } catch (_: Exception) {
            null
        }
    }

    private fun createLetterAvatar(name: String): Bitmap {
        val size = 192
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val backgroundPaint =
            Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = Color.parseColor("#324A8A")
                style = Paint.Style.FILL
            }
        canvas.drawCircle(size / 2f, size / 2f, size / 2f, backgroundPaint)

        val letter = name.trim().firstOrNull()?.uppercaseChar()?.toString() ?: "?"
        val textPaint =
            Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = Color.WHITE
                textAlign = Paint.Align.CENTER
                textSize = size * 0.5f
            }
        val bounds = Rect()
        textPaint.getTextBounds(letter, 0, letter.length, bounds)
        val y = size / 2f - bounds.exactCenterY()
        canvas.drawText(letter, size / 2f, y, textPaint)
        return bitmap
    }
}
