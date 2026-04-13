package com.tggf.app.localapi

class LocalRepository(
    private val dbPath: String = "tg_gf_local.db"
) {
    fun health(): Map<String, Any> {
        return mapOf(
            "ok" to true,
            "service" to "android-local-api",
            "storage" to "room",
            "dbPath" to dbPath
        )
    }
}

