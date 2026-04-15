package com.tggf.app.localapi

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

data class BackgroundDesiredStateRecord(
    val taskType: String,
    val scopeId: String,
    val enabled: Boolean,
    val payloadJson: String,
    val updatedAtMs: Long,
)

data class BackgroundRuntimeEventRecord(
    val id: Long,
    val taskType: String,
    val scopeId: String,
    val jobId: String?,
    val stage: String,
    val level: String,
    val message: String,
    val detailsJson: String?,
    val createdAtMs: Long,
)

class BackgroundRuntimeRepository(
    context: Context,
    dbName: String = "tg_gf_background_runtime.db",
) : SQLiteOpenHelper(context, dbName, null, DB_VERSION) {
    companion object {
        private const val DB_VERSION = 1

        private const val TABLE_DESIRED_STATE = "background_desired_state"
        private const val COL_TASK_TYPE = "task_type"
        private const val COL_SCOPE_ID = "scope_id"
        private const val COL_ENABLED = "enabled"
        private const val COL_PAYLOAD_JSON = "payload_json"
        private const val COL_UPDATED_AT_MS = "updated_at_ms"

        private const val TABLE_EVENTS = "background_runtime_events"
        private const val COL_EVENT_ID = "id"
        private const val COL_JOB_ID = "job_id"
        private const val COL_STAGE = "stage"
        private const val COL_LEVEL = "level"
        private const val COL_MESSAGE = "message"
        private const val COL_DETAILS_JSON = "details_json"
        private const val COL_CREATED_AT_MS = "created_at_ms"
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE $TABLE_DESIRED_STATE (
              $COL_TASK_TYPE TEXT NOT NULL,
              $COL_SCOPE_ID TEXT NOT NULL,
              $COL_ENABLED INTEGER NOT NULL DEFAULT 0,
              $COL_PAYLOAD_JSON TEXT NOT NULL DEFAULT '{}',
              $COL_UPDATED_AT_MS INTEGER NOT NULL,
              PRIMARY KEY ($COL_TASK_TYPE, $COL_SCOPE_ID)
            )
            """.trimIndent(),
        )
        db.execSQL(
            """
            CREATE INDEX idx_desired_state_task_enabled
            ON $TABLE_DESIRED_STATE ($COL_TASK_TYPE, $COL_ENABLED)
            """.trimIndent(),
        )
        db.execSQL(
            """
            CREATE TABLE $TABLE_EVENTS (
              $COL_EVENT_ID INTEGER PRIMARY KEY AUTOINCREMENT,
              $COL_TASK_TYPE TEXT NOT NULL,
              $COL_SCOPE_ID TEXT NOT NULL,
              $COL_JOB_ID TEXT NULL,
              $COL_STAGE TEXT NOT NULL,
              $COL_LEVEL TEXT NOT NULL,
              $COL_MESSAGE TEXT NOT NULL,
              $COL_DETAILS_JSON TEXT NULL,
              $COL_CREATED_AT_MS INTEGER NOT NULL
            )
            """.trimIndent(),
        )
        db.execSQL(
            """
            CREATE INDEX idx_runtime_events_created_at
            ON $TABLE_EVENTS ($COL_CREATED_AT_MS DESC)
            """.trimIndent(),
        )
        db.execSQL(
            """
            CREATE INDEX idx_runtime_events_task_scope
            ON $TABLE_EVENTS ($COL_TASK_TYPE, $COL_SCOPE_ID, $COL_CREATED_AT_MS DESC)
            """.trimIndent(),
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        // Version 1: no-op.
    }

    fun upsertDesiredState(
        taskType: String,
        scopeId: String,
        enabled: Boolean,
        payloadJson: String,
    ): BackgroundDesiredStateRecord {
        val now = System.currentTimeMillis()
        val values = ContentValues().apply {
            put(COL_TASK_TYPE, taskType)
            put(COL_SCOPE_ID, scopeId)
            put(COL_ENABLED, if (enabled) 1 else 0)
            put(COL_PAYLOAD_JSON, payloadJson.ifBlank { "{}" })
            put(COL_UPDATED_AT_MS, now)
        }
        writableDatabase.insertWithOnConflict(
            TABLE_DESIRED_STATE,
            null,
            values,
            SQLiteDatabase.CONFLICT_REPLACE,
        )
        return requireNotNull(getDesiredState(taskType, scopeId))
    }

    fun getDesiredState(taskType: String, scopeId: String): BackgroundDesiredStateRecord? {
        return readableDatabase.query(
            TABLE_DESIRED_STATE,
            null,
            "$COL_TASK_TYPE = ? AND $COL_SCOPE_ID = ?",
            arrayOf(taskType, scopeId),
            null,
            null,
            null,
            "1",
        ).use { cursor ->
            mapDesiredStateCursor(cursor).firstOrNull()
        }
    }

    fun listDesiredStates(taskType: String? = null): List<BackgroundDesiredStateRecord> {
        val normalizedTaskType = taskType?.trim()?.ifEmpty { null }
        val selection = if (normalizedTaskType == null) null else "$COL_TASK_TYPE = ?"
        val selectionArgs = if (normalizedTaskType == null) null else arrayOf(normalizedTaskType)
        return readableDatabase.query(
            TABLE_DESIRED_STATE,
            null,
            selection,
            selectionArgs,
            null,
            null,
            "$COL_UPDATED_AT_MS DESC",
        ).use { cursor ->
            mapDesiredStateCursor(cursor)
        }
    }

    fun countDesiredStates(taskType: String? = null, enabledOnly: Boolean = false): Int {
        val clauses = mutableListOf<String>()
        val args = mutableListOf<String>()
        val normalizedTaskType = taskType?.trim()?.ifEmpty { null }
        if (normalizedTaskType != null) {
            clauses.add("$COL_TASK_TYPE = ?")
            args.add(normalizedTaskType)
        }
        if (enabledOnly) {
            clauses.add("$COL_ENABLED = 1")
        }
        val selection = if (clauses.isEmpty()) null else clauses.joinToString(" AND ")
        val selectionArgs = if (args.isEmpty()) null else args.toTypedArray()
        return readableDatabase.rawQuery(
            """
            SELECT COUNT(1)
            FROM $TABLE_DESIRED_STATE
            ${if (selection == null) "" else "WHERE $selection"}
            """.trimIndent(),
            selectionArgs,
        ).use { cursor ->
            if (cursor.moveToFirst()) cursor.getInt(0) else 0
        }
    }

    fun appendEvent(
        taskType: String,
        scopeId: String,
        jobId: String?,
        stage: String,
        level: String,
        message: String,
        detailsJson: String?,
    ): BackgroundRuntimeEventRecord {
        val now = System.currentTimeMillis()
        val values = ContentValues().apply {
            put(COL_TASK_TYPE, taskType)
            put(COL_SCOPE_ID, scopeId)
            if (jobId.isNullOrBlank()) {
                putNull(COL_JOB_ID)
            } else {
                put(COL_JOB_ID, jobId.trim())
            }
            put(COL_STAGE, stage)
            put(COL_LEVEL, level)
            put(COL_MESSAGE, message)
            if (detailsJson.isNullOrBlank()) {
                putNull(COL_DETAILS_JSON)
            } else {
                put(COL_DETAILS_JSON, detailsJson)
            }
            put(COL_CREATED_AT_MS, now)
        }
        val id = writableDatabase.insert(TABLE_EVENTS, null, values)
        return BackgroundRuntimeEventRecord(
            id = id,
            taskType = taskType,
            scopeId = scopeId,
            jobId = jobId?.trim()?.ifEmpty { null },
            stage = stage,
            level = level,
            message = message,
            detailsJson = detailsJson,
            createdAtMs = now,
        )
    }

    fun listEvents(
        limit: Int = 120,
        taskType: String? = null,
        scopeId: String? = null,
    ): List<BackgroundRuntimeEventRecord> {
        val normalizedLimit = limit.coerceIn(1, 500)
        val clauses = mutableListOf<String>()
        val args = mutableListOf<String>()
        val normalizedTaskType = taskType?.trim()?.ifEmpty { null }
        val normalizedScopeId = scopeId?.trim()?.ifEmpty { null }
        if (normalizedTaskType != null) {
            clauses.add("$COL_TASK_TYPE = ?")
            args.add(normalizedTaskType)
        }
        if (normalizedScopeId != null) {
            clauses.add("$COL_SCOPE_ID = ?")
            args.add(normalizedScopeId)
        }
        val selection = if (clauses.isEmpty()) null else clauses.joinToString(" AND ")
        val selectionArgs = if (args.isEmpty()) null else args.toTypedArray()
        return readableDatabase.query(
            TABLE_EVENTS,
            null,
            selection,
            selectionArgs,
            null,
            null,
            "$COL_CREATED_AT_MS DESC",
            normalizedLimit.toString(),
        ).use { cursor ->
            mapEventCursor(cursor)
        }
    }

    fun clearEvents(
        taskType: String? = null,
        scopeId: String? = null,
    ): Int {
        val clauses = mutableListOf<String>()
        val args = mutableListOf<String>()
        val normalizedTaskType = taskType?.trim()?.ifEmpty { null }
        val normalizedScopeId = scopeId?.trim()?.ifEmpty { null }
        if (normalizedTaskType != null) {
            clauses.add("$COL_TASK_TYPE = ?")
            args.add(normalizedTaskType)
        }
        if (normalizedScopeId != null) {
            clauses.add("$COL_SCOPE_ID = ?")
            args.add(normalizedScopeId)
        }
        val selection = if (clauses.isEmpty()) null else clauses.joinToString(" AND ")
        val selectionArgs = if (args.isEmpty()) null else args.toTypedArray()
        return writableDatabase.delete(
            TABLE_EVENTS,
            selection,
            selectionArgs,
        )
    }

    fun countEvents(
        taskType: String? = null,
        stage: String? = null,
        level: String? = null,
    ): Int {
        val clauses = mutableListOf<String>()
        val args = mutableListOf<String>()
        val normalizedTaskType = taskType?.trim()?.ifEmpty { null }
        val normalizedStage = stage?.trim()?.ifEmpty { null }
        val normalizedLevel = level?.trim()?.ifEmpty { null }
        if (normalizedTaskType != null) {
            clauses.add("$COL_TASK_TYPE = ?")
            args.add(normalizedTaskType)
        }
        if (normalizedStage != null) {
            clauses.add("$COL_STAGE = ?")
            args.add(normalizedStage)
        }
        if (normalizedLevel != null) {
            clauses.add("$COL_LEVEL = ?")
            args.add(normalizedLevel)
        }
        val selection = if (clauses.isEmpty()) null else clauses.joinToString(" AND ")
        val selectionArgs = if (args.isEmpty()) null else args.toTypedArray()
        return readableDatabase.rawQuery(
            """
            SELECT COUNT(1)
            FROM $TABLE_EVENTS
            ${if (selection == null) "" else "WHERE $selection"}
            """.trimIndent(),
            selectionArgs,
        ).use { cursor ->
            if (cursor.moveToFirst()) cursor.getInt(0) else 0
        }
    }

    fun trimEvents(maxRows: Int = 1000): Int {
        val normalizedMaxRows = maxRows.coerceIn(100, 5000)
        val db = writableDatabase
        val idsToDelete = mutableListOf<Long>()
        db.query(
            TABLE_EVENTS,
            arrayOf(COL_EVENT_ID),
            null,
            null,
            null,
            null,
            "$COL_CREATED_AT_MS DESC",
            "1000000",
        ).use { cursor ->
            var index = 0
            while (cursor.moveToNext()) {
                index += 1
                if (index > normalizedMaxRows) {
                    idsToDelete.add(cursor.getLong(0))
                }
            }
        }
        if (idsToDelete.isEmpty()) return 0
        val placeholders = idsToDelete.joinToString(",") { "?" }
        return db.delete(
            TABLE_EVENTS,
            "$COL_EVENT_ID IN ($placeholders)",
            idsToDelete.map { it.toString() }.toTypedArray(),
        )
    }

    private fun mapDesiredStateCursor(cursor: Cursor): List<BackgroundDesiredStateRecord> {
        val taskTypeIndex = cursor.getColumnIndexOrThrow(COL_TASK_TYPE)
        val scopeIdIndex = cursor.getColumnIndexOrThrow(COL_SCOPE_ID)
        val enabledIndex = cursor.getColumnIndexOrThrow(COL_ENABLED)
        val payloadJsonIndex = cursor.getColumnIndexOrThrow(COL_PAYLOAD_JSON)
        val updatedAtIndex = cursor.getColumnIndexOrThrow(COL_UPDATED_AT_MS)
        val rows = mutableListOf<BackgroundDesiredStateRecord>()
        while (cursor.moveToNext()) {
            rows.add(
                BackgroundDesiredStateRecord(
                    taskType = cursor.getString(taskTypeIndex),
                    scopeId = cursor.getString(scopeIdIndex),
                    enabled = cursor.getInt(enabledIndex) > 0,
                    payloadJson = cursor.getString(payloadJsonIndex) ?: "{}",
                    updatedAtMs = cursor.getLong(updatedAtIndex),
                ),
            )
        }
        return rows
    }

    private fun mapEventCursor(cursor: Cursor): List<BackgroundRuntimeEventRecord> {
        val idIndex = cursor.getColumnIndexOrThrow(COL_EVENT_ID)
        val taskTypeIndex = cursor.getColumnIndexOrThrow(COL_TASK_TYPE)
        val scopeIdIndex = cursor.getColumnIndexOrThrow(COL_SCOPE_ID)
        val jobIdIndex = cursor.getColumnIndexOrThrow(COL_JOB_ID)
        val stageIndex = cursor.getColumnIndexOrThrow(COL_STAGE)
        val levelIndex = cursor.getColumnIndexOrThrow(COL_LEVEL)
        val messageIndex = cursor.getColumnIndexOrThrow(COL_MESSAGE)
        val detailsIndex = cursor.getColumnIndexOrThrow(COL_DETAILS_JSON)
        val createdAtIndex = cursor.getColumnIndexOrThrow(COL_CREATED_AT_MS)
        val rows = mutableListOf<BackgroundRuntimeEventRecord>()
        while (cursor.moveToNext()) {
            rows.add(
                BackgroundRuntimeEventRecord(
                    id = cursor.getLong(idIndex),
                    taskType = cursor.getString(taskTypeIndex),
                    scopeId = cursor.getString(scopeIdIndex),
                    jobId = if (cursor.isNull(jobIdIndex)) null else cursor.getString(jobIdIndex),
                    stage = cursor.getString(stageIndex),
                    level = cursor.getString(levelIndex),
                    message = cursor.getString(messageIndex),
                    detailsJson = if (cursor.isNull(detailsIndex)) null else cursor.getString(detailsIndex),
                    createdAtMs = cursor.getLong(createdAtIndex),
                ),
            )
        }
        return rows
    }
}
