package com.tggf.app.localapi

import android.content.Context

class LocalRepository(
    context: Context,
    private val dbPath: String = "tg_gf_local.db"
) {
    private val prefs = context.getSharedPreferences("tg_gf_local_api", Context.MODE_PRIVATE)
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
        return mapOf(
            "ok" to true,
            "service" to "android-local-api",
            "storage" to "room",
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
        return prefs.getString(key, null)
    }

    fun writeStoreJson(storeName: String, value: String) {
        val key = storeKeyByName[storeName] ?: return
        prefs.edit().putString(key, value).apply()
    }

    fun clearStoreJson(storeName: String) {
        val key = storeKeyByName[storeName] ?: return
        prefs.edit().remove(key).apply()
    }
}

