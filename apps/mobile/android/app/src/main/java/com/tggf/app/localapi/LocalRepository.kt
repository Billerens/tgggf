package com.tggf.app.localapi

import android.content.Context
import org.json.JSONObject

class LocalRepository(
    context: Context,
    private val dbPath: String = "tg_gf_local.db"
) {
    private val appContext = context.applicationContext
    private val prefs = appContext.getSharedPreferences("tg_gf_local_api", Context.MODE_PRIVATE)
    private val groupRuntimeStoreRepository by lazy { GroupRuntimeStoreRepository(appContext) }
    private val settingsJsonKey = "settings_json"
    private val personasJsonKey = "personas_json"
    private val chatsJsonKey = "chats_json"
    private val messagesJsonKey = "messages_json"
    private val personaStatesJsonKey = "persona_states_json"
    private val memoriesJsonKey = "memories_json"
    private val generatorSessionsJsonKey = "generator_sessions_json"
    private val imageAssetsJsonKey = "image_assets_json"
    private val groupRoomsJsonKey = "group_rooms_json"
    private val groupParticipantsJsonKey = "group_participants_json"
    private val groupMessagesJsonKey = "group_messages_json"
    private val groupEventsJsonKey = "group_events_json"
    private val groupPersonaStatesJsonKey = "group_persona_states_json"
    private val groupRelationEdgesJsonKey = "group_relation_edges_json"
    private val groupSharedMemoriesJsonKey = "group_shared_memories_json"
    private val groupPrivateMemoriesJsonKey = "group_private_memories_json"
    private val groupSnapshotsJsonKey = "group_snapshots_json"
    private val structuredGroupStoreNames =
        setOf(
            "groupRooms",
            "groupParticipants",
            "groupMessages",
            "groupEvents",
            "groupPersonaStates",
            "groupRelationEdges",
            "groupSharedMemories",
            "groupPrivateMemories",
            "groupSnapshots",
        )
    private val storeKeyByName = mapOf(
        "settings" to settingsJsonKey,
        "personas" to personasJsonKey,
        "chats" to chatsJsonKey,
        "messages" to messagesJsonKey,
        "personaStates" to personaStatesJsonKey,
        "memories" to memoriesJsonKey,
        "generatorSessions" to generatorSessionsJsonKey,
        "imageAssets" to imageAssetsJsonKey,
        "groupRooms" to groupRoomsJsonKey,
        "groupParticipants" to groupParticipantsJsonKey,
        "groupMessages" to groupMessagesJsonKey,
        "groupEvents" to groupEventsJsonKey,
        "groupPersonaStates" to groupPersonaStatesJsonKey,
        "groupRelationEdges" to groupRelationEdgesJsonKey,
        "groupSharedMemories" to groupSharedMemoriesJsonKey,
        "groupPrivateMemories" to groupPrivateMemoriesJsonKey,
        "groupSnapshots" to groupSnapshotsJsonKey
    )

    fun health(): Map<String, Any> {
        val structuredEnabled = isStructuredGroupStorageEnabled()
        val dualWriteEnabled = isStructuredGroupStorageDualWriteEnabled()
        return mapOf(
            "ok" to true,
            "service" to "android-local-api",
            "storage" to
                if (structuredEnabled) {
                    "sqlite_group_runtime_primary"
                } else {
                    "shared_preferences_json"
                },
            "groupStoragePrimary" to if (structuredEnabled) "sqlite" else "shared_preferences",
            "groupStorageCompatDualWrite" to dualWriteEnabled,
            "dbPath" to dbPath
        )
    }

    fun readSettingsJson(): String? {
        return prefs.getString(settingsJsonKey, null)
    }

    fun writeSettingsJson(value: String) {
        prefs.edit().putString(settingsJsonKey, value).apply()
    }

    fun readPersonasJson(): String? {
        return prefs.getString(personasJsonKey, null)
    }

    fun writePersonasJson(value: String) {
        prefs.edit().putString(personasJsonKey, value).apply()
    }

    fun readChatsJson(): String? {
        return prefs.getString(chatsJsonKey, null)
    }

    fun writeChatsJson(value: String) {
        prefs.edit().putString(chatsJsonKey, value).apply()
    }

    fun readMessagesJson(): String? {
        return prefs.getString(messagesJsonKey, null)
    }

    fun writeMessagesJson(value: String) {
        prefs.edit().putString(messagesJsonKey, value).apply()
    }

    fun knownStoreNames(): Set<String> {
        return storeKeyByName.keys
    }

    fun readStoreJson(storeName: String): String? {
        val key = storeKeyByName[storeName] ?: return null
        val normalizedStoreName = storeName.trim()
        if (normalizedStoreName.isNotEmpty() && isStructuredGroupStore(normalizedStoreName) && isStructuredGroupStorageEnabled()) {
            val sqliteValue = groupRuntimeStoreRepository.readStoreJson(normalizedStoreName)
            if (!sqliteValue.isNullOrBlank()) {
                return sqliteValue
            }

            val legacyValue = prefs.getString(key, null)
            if (!legacyValue.isNullOrBlank()) {
                // Lazy migration path: backfill SQLite on first read of legacy payload.
                groupRuntimeStoreRepository.writeStoreJson(normalizedStoreName, legacyValue)
                return legacyValue
            }
            return null
        }
        return prefs.getString(key, null)
    }

    fun writeStoreJson(storeName: String, value: String) {
        val key = storeKeyByName[storeName] ?: return
        val normalizedStoreName = storeName.trim()
        if (normalizedStoreName.isNotEmpty() && isStructuredGroupStore(normalizedStoreName) && isStructuredGroupStorageEnabled()) {
            groupRuntimeStoreRepository.writeStoreJson(normalizedStoreName, value)
            if (isStructuredGroupStorageDualWriteEnabled()) {
                prefs.edit().putString(key, value).apply()
            }
            return
        }
        prefs.edit().putString(key, value).apply()
    }

    fun clearStoreJson(storeName: String) {
        val key = storeKeyByName[storeName] ?: return
        val normalizedStoreName = storeName.trim()
        if (normalizedStoreName.isNotEmpty() && isStructuredGroupStore(normalizedStoreName)) {
            groupRuntimeStoreRepository.clearStore(normalizedStoreName)
        }
        prefs.edit().remove(key).apply()
    }

    private fun isStructuredGroupStore(storeName: String): Boolean {
        return structuredGroupStoreNames.contains(storeName)
    }

    private fun isStructuredGroupStorageEnabled(): Boolean {
        val settings = parseSettingsJson()
        return settings.optBoolean("androidNativeGroupStructuredStorageV1", true)
    }

    private fun isStructuredGroupStorageDualWriteEnabled(): Boolean {
        val settings = parseSettingsJson()
        return settings.optBoolean("androidNativeGroupStructuredStorageDualWrite", true)
    }

    private fun parseSettingsJson(): JSONObject {
        val raw = prefs.getString(settingsJsonKey, null)
        if (raw.isNullOrBlank()) return JSONObject()
        return try {
            JSONObject(raw)
        } catch (_: Exception) {
            JSONObject()
        }
    }
}

