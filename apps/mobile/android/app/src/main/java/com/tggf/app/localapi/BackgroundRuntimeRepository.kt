package com.tggf.app.localapi

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.util.Log

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

data class BackgroundDeltaRecord(
    val id: Long,
    val taskType: String,
    val scopeId: String,
    val kind: String,
    val entityType: String,
    val entityId: String?,
    val payloadJson: String,
    val createdAtMs: Long,
)

class BackgroundRuntimeRepository(
    context: Context,
    dbName: String = "tg_gf_background_runtime.db",
) : SQLiteOpenHelper(context, dbName, null, DB_VERSION) {
    private val appContext = context.applicationContext
    private val prefs =
        appContext.getSharedPreferences("tg_gf_local_api", Context.MODE_PRIVATE)

    companion object {
        private const val DB_VERSION = 2
        const val GLOBAL_SCOPE_ID = "global"
        private const val TAG = "BackgroundRuntimeRepo"
        private const val DELTA_PAYLOAD_SAFE_SELECT_MAX_CHARS = 512_000
        private const val DELTA_PAYLOAD_PURGE_MAX_CHARS = 256_000
        private const val DELTA_OVERSIZE_PURGE_MARKER_KEY =
            "background_delta_oversize_purge_v1_done"

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

        private const val TABLE_DELTA = "background_delta"
        private const val COL_DELTA_ID = "id"
        private const val COL_KIND = "kind"
        private const val COL_ENTITY_TYPE = "entity_type"
        private const val COL_ENTITY_ID = "entity_id"
        private const val COL_DELTA_PAYLOAD_JSON = "payload_json"
    }

    init {
        runOneTimeOversizedDeltaCleanup()
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
        createDeltaSchema(db)
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) {
            createDeltaSchema(db)
        }
    }

    private fun createDeltaSchema(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS $TABLE_DELTA (
              $COL_DELTA_ID INTEGER PRIMARY KEY AUTOINCREMENT,
              $COL_TASK_TYPE TEXT NOT NULL,
              $COL_SCOPE_ID TEXT NOT NULL,
              $COL_KIND TEXT NOT NULL,
              $COL_ENTITY_TYPE TEXT NOT NULL,
              $COL_ENTITY_ID TEXT NULL,
              $COL_DELTA_PAYLOAD_JSON TEXT NOT NULL DEFAULT '{}',
              $COL_CREATED_AT_MS INTEGER NOT NULL
            )
            """.trimIndent(),
        )
        db.execSQL(
            """
            CREATE INDEX IF NOT EXISTS idx_delta_created_at
            ON $TABLE_DELTA ($COL_CREATED_AT_MS ASC)
            """.trimIndent(),
        )
        db.execSQL(
            """
            CREATE INDEX IF NOT EXISTS idx_delta_task_scope_id
            ON $TABLE_DELTA ($COL_TASK_TYPE, $COL_SCOPE_ID, $COL_DELTA_ID ASC)
            """.trimIndent(),
        )
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

    fun appendDelta(
        taskType: String,
        scopeId: String,
        kind: String,
        entityType: String,
        entityId: String?,
        payloadJson: String,
    ): BackgroundDeltaRecord {
        val normalizedTaskType = taskType.trim()
        val normalizedScopeId = scopeId.trim().ifEmpty { GLOBAL_SCOPE_ID }
        val normalizedKind = kind.trim()
        val normalizedEntityType = entityType.trim()
        val normalizedEntityId = entityId?.trim()?.ifEmpty { null }
        val normalizedPayloadJson = payloadJson.trim().ifEmpty { "{}" }
        val now = System.currentTimeMillis()
        val db = writableDatabase
        db.beginTransaction()
        try {
            val values = ContentValues().apply {
                put(COL_TASK_TYPE, normalizedTaskType)
                put(COL_SCOPE_ID, normalizedScopeId)
                put(COL_KIND, normalizedKind)
                put(COL_ENTITY_TYPE, normalizedEntityType)
                if (normalizedEntityId == null) {
                    putNull(COL_ENTITY_ID)
                } else {
                    put(COL_ENTITY_ID, normalizedEntityId)
                }
                put(COL_DELTA_PAYLOAD_JSON, normalizedPayloadJson)
                put(COL_CREATED_AT_MS, now)
            }
            val rowId = db.insert(TABLE_DELTA, null, values)
            if (rowId <= 0L) {
                throw IllegalStateException("Failed to append background delta")
            }
            db.setTransactionSuccessful()
            return BackgroundDeltaRecord(
                id = rowId,
                taskType = normalizedTaskType,
                scopeId = normalizedScopeId,
                kind = normalizedKind,
                entityType = normalizedEntityType,
                entityId = normalizedEntityId,
                payloadJson = normalizedPayloadJson,
                createdAtMs = now,
            )
        } finally {
            db.endTransaction()
        }
    }

    fun listDelta(
        sinceId: Long = 0L,
        limit: Int = 200,
        taskType: String? = null,
        scopeIds: List<String>? = null,
        includeGlobalScope: Boolean = true,
    ): List<BackgroundDeltaRecord> {
        val normalizedSinceId = maxOf(0L, sinceId)
        val normalizedLimit = limit.coerceIn(1, 1000)
        val clauses = mutableListOf<String>()
        val args = mutableListOf<String>()
        clauses.add("$COL_DELTA_ID > ?")
        args.add(normalizedSinceId.toString())

        val normalizedTaskType = taskType?.trim()?.ifEmpty { null }
        if (normalizedTaskType != null) {
            clauses.add("$COL_TASK_TYPE = ?")
            args.add(normalizedTaskType)
        }

        val normalizedScopeIds =
            scopeIds
                ?.map { it.trim() }
                ?.filter { it.isNotEmpty() }
                ?.distinct()
                .orEmpty()
        if (normalizedScopeIds.isNotEmpty() || includeGlobalScope) {
            val targetScopeIds = mutableListOf<String>()
            targetScopeIds.addAll(normalizedScopeIds)
            if (includeGlobalScope && !targetScopeIds.contains(GLOBAL_SCOPE_ID)) {
                targetScopeIds.add(GLOBAL_SCOPE_ID)
            }
            if (targetScopeIds.isNotEmpty()) {
                val placeholders = targetScopeIds.joinToString(",") { "?" }
                clauses.add("$COL_SCOPE_ID IN ($placeholders)")
                args.addAll(targetScopeIds)
            }
        }

        val selection = clauses.joinToString(" AND ")
        val queryArgs = args.toMutableList().apply { add(normalizedLimit.toString()) }
        val sql =
            """
            SELECT
              $COL_DELTA_ID,
              $COL_TASK_TYPE,
              $COL_SCOPE_ID,
              $COL_KIND,
              $COL_ENTITY_TYPE,
              $COL_ENTITY_ID,
              CASE
                WHEN LENGTH($COL_DELTA_PAYLOAD_JSON) > $DELTA_PAYLOAD_SAFE_SELECT_MAX_CHARS THEN '{}'
                ELSE COALESCE($COL_DELTA_PAYLOAD_JSON, '{}')
              END AS $COL_DELTA_PAYLOAD_JSON,
              $COL_CREATED_AT_MS
            FROM $TABLE_DELTA
            WHERE $selection
            ORDER BY $COL_DELTA_ID ASC
            LIMIT ?
            """.trimIndent()
        return readableDatabase.rawQuery(sql, queryArgs.toTypedArray()).use { cursor ->
            mapDeltaCursor(cursor)
        }
    }

    fun ackDeltaUpTo(ackedUpToId: Long, taskType: String? = null): Int {
        val normalizedAckId = maxOf(0L, ackedUpToId)
        if (normalizedAckId <= 0L) return 0
        val normalizedTaskType = taskType?.trim()?.ifEmpty { null }
        val clauses = mutableListOf<String>()
        val args = mutableListOf<String>()
        clauses.add("$COL_DELTA_ID <= ?")
        args.add(normalizedAckId.toString())
        if (normalizedTaskType != null) {
            clauses.add("$COL_TASK_TYPE = ?")
            args.add(normalizedTaskType)
        }
        return writableDatabase.delete(
            TABLE_DELTA,
            clauses.joinToString(" AND "),
            args.toTypedArray(),
        )
    }

    fun latestDeltaId(): Long {
        return readableDatabase.rawQuery(
            """
            SELECT MAX($COL_DELTA_ID)
            FROM $TABLE_DELTA
            """.trimIndent(),
            null,
        ).use { cursor ->
            if (!cursor.moveToFirst() || cursor.isNull(0)) {
                0L
            } else {
                cursor.getLong(0)
            }
        }
    }

    private fun runOneTimeOversizedDeltaCleanup() {
        if (prefs.getBoolean(DELTA_OVERSIZE_PURGE_MARKER_KEY, false)) return
        try {
            writableDatabase.delete(
                TABLE_DELTA,
                "LENGTH($COL_DELTA_PAYLOAD_JSON) > ?",
                arrayOf(DELTA_PAYLOAD_PURGE_MAX_CHARS.toString()),
            )
            prefs.edit().putBoolean(DELTA_OVERSIZE_PURGE_MARKER_KEY, true).apply()
        } catch (error: Exception) {
            Log.w(TAG, "One-time oversized delta cleanup failed", error)
        }
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

    private fun mapDeltaCursor(cursor: Cursor): List<BackgroundDeltaRecord> {
        val idIndex = cursor.getColumnIndexOrThrow(COL_DELTA_ID)
        val taskTypeIndex = cursor.getColumnIndexOrThrow(COL_TASK_TYPE)
        val scopeIdIndex = cursor.getColumnIndexOrThrow(COL_SCOPE_ID)
        val kindIndex = cursor.getColumnIndexOrThrow(COL_KIND)
        val entityTypeIndex = cursor.getColumnIndexOrThrow(COL_ENTITY_TYPE)
        val entityIdIndex = cursor.getColumnIndexOrThrow(COL_ENTITY_ID)
        val payloadIndex = cursor.getColumnIndexOrThrow(COL_DELTA_PAYLOAD_JSON)
        val createdAtIndex = cursor.getColumnIndexOrThrow(COL_CREATED_AT_MS)
        val rows = mutableListOf<BackgroundDeltaRecord>()
        while (cursor.moveToNext()) {
            rows.add(
                BackgroundDeltaRecord(
                    id = cursor.getLong(idIndex),
                    taskType = cursor.getString(taskTypeIndex),
                    scopeId = cursor.getString(scopeIdIndex),
                    kind = cursor.getString(kindIndex),
                    entityType = cursor.getString(entityTypeIndex),
                    entityId = if (cursor.isNull(entityIdIndex)) null else cursor.getString(entityIdIndex),
                    payloadJson = cursor.getString(payloadIndex) ?: "{}",
                    createdAtMs = cursor.getLong(createdAtIndex),
                ),
            )
        }
        return rows
    }
}
