package com.tggf.app.localapi

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

class GroupRuntimeStoreRepository(
    context: Context,
    dbName: String = "tg_gf_group_runtime.db",
) : SQLiteOpenHelper(context, dbName, null, DB_VERSION) {
    companion object {
        private const val DB_VERSION = 1

        private const val TABLE_STORE = "group_runtime_store"
        private const val COL_STORE_NAME = "store_name"
        private const val COL_PAYLOAD_JSON = "payload_json"
        private const val COL_UPDATED_AT_MS = "updated_at_ms"
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE $TABLE_STORE (
              $COL_STORE_NAME TEXT PRIMARY KEY,
              $COL_PAYLOAD_JSON TEXT NOT NULL,
              $COL_UPDATED_AT_MS INTEGER NOT NULL
            )
            """.trimIndent(),
        )
        db.execSQL(
            """
            CREATE INDEX idx_group_runtime_store_updated
            ON $TABLE_STORE ($COL_UPDATED_AT_MS DESC)
            """.trimIndent(),
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        // Version 1: no-op.
    }

    fun readStoreJson(storeName: String): String? {
        val normalizedStoreName = storeName.trim()
        if (normalizedStoreName.isEmpty()) return null
        return readableDatabase.query(
            TABLE_STORE,
            arrayOf(COL_PAYLOAD_JSON),
            "$COL_STORE_NAME = ?",
            arrayOf(normalizedStoreName),
            null,
            null,
            null,
            "1",
        ).use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        }
    }

    fun writeStoreJson(storeName: String, payloadJson: String) {
        val normalizedStoreName = storeName.trim()
        if (normalizedStoreName.isEmpty()) return
        val values =
            ContentValues().apply {
                put(COL_STORE_NAME, normalizedStoreName)
                put(COL_PAYLOAD_JSON, payloadJson)
                put(COL_UPDATED_AT_MS, System.currentTimeMillis())
            }
        writableDatabase.insertWithOnConflict(
            TABLE_STORE,
            null,
            values,
            SQLiteDatabase.CONFLICT_REPLACE,
        )
    }

    fun clearStore(storeName: String) {
        val normalizedStoreName = storeName.trim()
        if (normalizedStoreName.isEmpty()) return
        writableDatabase.delete(
            TABLE_STORE,
            "$COL_STORE_NAME = ?",
            arrayOf(normalizedStoreName),
        )
    }
}

