package com.tggf.app.localapi

import android.content.Context

class LocalRepository(
    context: Context,
    private val dbPath: String = "tg_gf_local.db"
) : AutoCloseable {
    private val appContext = context.applicationContext
    private val prefs = appContext.getSharedPreferences("tg_gf_local_api", Context.MODE_PRIVATE)
    private val groupRuntimeStoreRepositoryDelegate = lazy { GroupRuntimeStoreRepository(appContext) }
    private val groupRuntimeStoreRepository by groupRuntimeStoreRepositoryDelegate
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
    private val backgroundEngineV2ResetMarkerKey = "background_engine_v2_reset_done"
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

    init {
        runOneTimeBackgroundEngineV2Reset()
    }

    fun health(): Map<String, Any> {
        return mapOf(
            "ok" to true,
            "service" to "android-local-api",
            "storage" to "sqlite_group_runtime_primary",
            "groupStoragePrimary" to "sqlite",
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
        if (normalizedStoreName.isNotEmpty() && isStructuredGroupStore(normalizedStoreName)) {
            return groupRuntimeStoreRepository.readStoreJson(normalizedStoreName)
        }
        return prefs.getString(key, null)
    }

    fun writeStoreJson(storeName: String, value: String) {
        val key = storeKeyByName[storeName] ?: return
        val normalizedStoreName = storeName.trim()
        if (normalizedStoreName.isNotEmpty() && isStructuredGroupStore(normalizedStoreName)) {
            groupRuntimeStoreRepository.writeStoreJson(normalizedStoreName, value)
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

    private fun runOneTimeBackgroundEngineV2Reset() {
        if (prefs.getBoolean(backgroundEngineV2ResetMarkerKey, false)) return
        val editor = prefs.edit()
        for (key in storeKeyByName.values.toSet()) {
            editor.remove(key)
        }
        editor.putBoolean(backgroundEngineV2ResetMarkerKey, true)
        editor.apply()
        for (storeName in structuredGroupStoreNames) {
            groupRuntimeStoreRepository.clearStore(storeName)
        }
    }

    override fun close() {
        if (!groupRuntimeStoreRepositoryDelegate.isInitialized()) return
        groupRuntimeStoreRepository.closeQuietly()
    }
}

