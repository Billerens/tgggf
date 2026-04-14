package com.tggf.app.localapi

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

data class BackgroundJobRecord(
    val id: String,
    val type: String,
    val payloadJson: String,
    val status: String,
    val runAtMs: Long,
    val leaseUntilMs: Long?,
    val attempts: Int,
    val maxAttempts: Int,
    val lastError: String?,
    val createdAtMs: Long,
    val updatedAtMs: Long,
)

class BackgroundJobRepository(
    context: Context,
    private val dbName: String = "tg_gf_background_jobs.db",
) : SQLiteOpenHelper(context, dbName, null, DB_VERSION) {
    companion object {
        private const val DB_VERSION = 1

        private const val TABLE_JOBS = "background_jobs"
        private const val COL_ID = "id"
        private const val COL_TYPE = "type"
        private const val COL_PAYLOAD_JSON = "payload_json"
        private const val COL_STATUS = "status"
        private const val COL_RUN_AT_MS = "run_at_ms"
        private const val COL_LEASE_UNTIL_MS = "lease_until_ms"
        private const val COL_ATTEMPTS = "attempts"
        private const val COL_MAX_ATTEMPTS = "max_attempts"
        private const val COL_LAST_ERROR = "last_error"
        private const val COL_CREATED_AT_MS = "created_at_ms"
        private const val COL_UPDATED_AT_MS = "updated_at_ms"

        const val STATUS_PENDING = "pending"
        const val STATUS_LEASED = "leased"
        const val STATUS_COMPLETED = "completed"
        const val STATUS_FAILED = "failed"
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE $TABLE_JOBS (
              $COL_ID TEXT PRIMARY KEY,
              $COL_TYPE TEXT NOT NULL,
              $COL_PAYLOAD_JSON TEXT NOT NULL,
              $COL_STATUS TEXT NOT NULL,
              $COL_RUN_AT_MS INTEGER NOT NULL,
              $COL_LEASE_UNTIL_MS INTEGER NULL,
              $COL_ATTEMPTS INTEGER NOT NULL DEFAULT 0,
              $COL_MAX_ATTEMPTS INTEGER NOT NULL DEFAULT 0,
              $COL_LAST_ERROR TEXT NULL,
              $COL_CREATED_AT_MS INTEGER NOT NULL,
              $COL_UPDATED_AT_MS INTEGER NOT NULL
            )
            """.trimIndent(),
        )
        db.execSQL(
            """
            CREATE INDEX idx_jobs_status_run_at
            ON $TABLE_JOBS ($COL_STATUS, $COL_RUN_AT_MS)
            """.trimIndent(),
        )
        db.execSQL(
            """
            CREATE INDEX idx_jobs_lease_until
            ON $TABLE_JOBS ($COL_LEASE_UNTIL_MS)
            """.trimIndent(),
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        // Version 1: no-op.
    }

    fun ensureRecurringJob(
        id: String,
        type: String,
        payloadJson: String,
        runAtMs: Long,
        maxAttempts: Int,
    ): BackgroundJobRecord {
        val now = System.currentTimeMillis()
        val db = writableDatabase
        db.beginTransaction()
        try {
            val existing = getJobByIdInternal(db, id)
            if (existing == null) {
                insertJobInternal(
                    db = db,
                    id = id,
                    type = type,
                    payloadJson = payloadJson,
                    status = STATUS_PENDING,
                    runAtMs = runAtMs,
                    leaseUntilMs = null,
                    attempts = 0,
                    maxAttempts = maxAttempts,
                    lastError = null,
                    createdAtMs = now,
                    updatedAtMs = now,
                )
            } else {
                val nextStatus = when (existing.status) {
                    STATUS_COMPLETED, STATUS_FAILED -> STATUS_PENDING
                    else -> existing.status
                }
                val nextRunAt = when (nextStatus) {
                    STATUS_PENDING -> minOf(existing.runAtMs, runAtMs)
                    else -> existing.runAtMs
                }
                val values = ContentValues().apply {
                    put(COL_TYPE, type)
                    put(COL_PAYLOAD_JSON, payloadJson)
                    put(COL_STATUS, nextStatus)
                    put(COL_RUN_AT_MS, nextRunAt)
                    put(COL_MAX_ATTEMPTS, maxAttempts)
                    put(COL_UPDATED_AT_MS, now)
                    if (nextStatus == STATUS_PENDING) {
                        putNull(COL_LEASE_UNTIL_MS)
                    }
                }
                db.update(TABLE_JOBS, values, "$COL_ID = ?", arrayOf(id))
            }
            val updated = getJobByIdInternal(db, id)
            db.setTransactionSuccessful()
            return requireNotNull(updated)
        } finally {
            db.endTransaction()
        }
    }

    fun cancelJob(id: String): Boolean {
        val values = ContentValues().apply {
            put(COL_STATUS, STATUS_COMPLETED)
            putNull(COL_LEASE_UNTIL_MS)
            put(COL_UPDATED_AT_MS, System.currentTimeMillis())
        }
        return writableDatabase.update(TABLE_JOBS, values, "$COL_ID = ?", arrayOf(id)) > 0
    }

    fun completeJob(id: String): Boolean {
        val values = ContentValues().apply {
            put(COL_STATUS, STATUS_COMPLETED)
            putNull(COL_LEASE_UNTIL_MS)
            put(COL_LAST_ERROR, "")
            put(COL_UPDATED_AT_MS, System.currentTimeMillis())
        }
        return writableDatabase.update(TABLE_JOBS, values, "$COL_ID = ?", arrayOf(id)) > 0
    }

    fun rescheduleJob(
        id: String,
        runAtMs: Long,
        incrementAttempts: Boolean,
        lastError: String?,
    ): Boolean {
        val db = writableDatabase
        db.beginTransaction()
        try {
            val existing = getJobByIdInternal(db, id) ?: return false
            val nextAttempts = if (incrementAttempts) existing.attempts + 1 else existing.attempts
            val maxAttempts = existing.maxAttempts
            val status =
                if (maxAttempts > 0 && nextAttempts >= maxAttempts) STATUS_FAILED else STATUS_PENDING
            val values = ContentValues().apply {
                put(COL_STATUS, status)
                put(COL_RUN_AT_MS, runAtMs)
                put(COL_ATTEMPTS, nextAttempts)
                if (status == STATUS_PENDING) {
                    putNull(COL_LEASE_UNTIL_MS)
                }
                if (lastError.isNullOrBlank()) {
                    putNull(COL_LAST_ERROR)
                } else {
                    put(COL_LAST_ERROR, lastError.trim())
                }
                put(COL_UPDATED_AT_MS, System.currentTimeMillis())
            }
            val updated = db.update(TABLE_JOBS, values, "$COL_ID = ?", arrayOf(id)) > 0
            db.setTransactionSuccessful()
            return updated
        } finally {
            db.endTransaction()
        }
    }

    fun claimDueJobs(limit: Int, leaseMs: Long, type: String? = null): List<BackgroundJobRecord> {
        val normalizedLimit = limit.coerceIn(1, 50)
        val normalizedLeaseMs = leaseMs.coerceIn(1_000L, 120_000L)
        val now = System.currentTimeMillis()
        val leaseUntilMs = now + normalizedLeaseMs
        val db = writableDatabase
        db.beginTransaction()
        try {
            val normalizedType = type?.trim()?.ifEmpty { null }
            val selectionBuilder =
                StringBuilder(
                    """
                (
                  ($COL_STATUS = ? AND $COL_RUN_AT_MS <= ?)
                  OR
                  ($COL_STATUS = ? AND $COL_LEASE_UNTIL_MS IS NOT NULL AND $COL_LEASE_UNTIL_MS <= ?)
                )
                AND
                ($COL_MAX_ATTEMPTS <= 0 OR $COL_ATTEMPTS < $COL_MAX_ATTEMPTS)
                """.trimIndent(),
                )
            val selectionArgs = mutableListOf(
                STATUS_PENDING,
                now.toString(),
                STATUS_LEASED,
                now.toString(),
            )
            if (normalizedType != null) {
                selectionBuilder.append(" AND $COL_TYPE = ?")
                selectionArgs.add(normalizedType)
            }
            val dueIds = mutableListOf<String>()
            db.query(
                TABLE_JOBS,
                arrayOf(COL_ID),
                selectionBuilder.toString(),
                selectionArgs.toTypedArray(),
                null,
                null,
                "$COL_RUN_AT_MS ASC",
                normalizedLimit.toString(),
            ).use { cursor ->
                while (cursor.moveToNext()) {
                    dueIds.add(cursor.getString(0))
                }
            }
            if (dueIds.isEmpty()) {
                db.setTransactionSuccessful()
                return emptyList()
            }

            val values = ContentValues().apply {
                put(COL_STATUS, STATUS_LEASED)
                put(COL_LEASE_UNTIL_MS, leaseUntilMs)
                put(COL_UPDATED_AT_MS, now)
            }
            for (jobId in dueIds) {
                db.update(TABLE_JOBS, values, "$COL_ID = ?", arrayOf(jobId))
            }
            val claimed = getJobsByIdsInternal(db, dueIds)
            db.setTransactionSuccessful()
            return claimed
        } finally {
            db.endTransaction()
        }
    }

    fun listJobs(status: String?, limit: Int): List<BackgroundJobRecord> {
        val normalizedLimit = limit.coerceIn(1, 200)
        val db = readableDatabase
        val selection = if (status.isNullOrBlank()) null else "$COL_STATUS = ?"
        val selectionArgs = if (status.isNullOrBlank()) null else arrayOf(status.trim())
        return db.query(
            TABLE_JOBS,
            null,
            selection,
            selectionArgs,
            null,
            null,
            "$COL_UPDATED_AT_MS DESC",
            normalizedLimit.toString(),
        ).use { cursor ->
            mapCursor(cursor)
        }
    }

    private fun insertJobInternal(
        db: SQLiteDatabase,
        id: String,
        type: String,
        payloadJson: String,
        status: String,
        runAtMs: Long,
        leaseUntilMs: Long?,
        attempts: Int,
        maxAttempts: Int,
        lastError: String?,
        createdAtMs: Long,
        updatedAtMs: Long,
    ) {
        val values = ContentValues().apply {
            put(COL_ID, id)
            put(COL_TYPE, type)
            put(COL_PAYLOAD_JSON, payloadJson)
            put(COL_STATUS, status)
            put(COL_RUN_AT_MS, runAtMs)
            if (leaseUntilMs == null) {
                putNull(COL_LEASE_UNTIL_MS)
            } else {
                put(COL_LEASE_UNTIL_MS, leaseUntilMs)
            }
            put(COL_ATTEMPTS, attempts)
            put(COL_MAX_ATTEMPTS, maxAttempts)
            if (lastError.isNullOrBlank()) {
                putNull(COL_LAST_ERROR)
            } else {
                put(COL_LAST_ERROR, lastError.trim())
            }
            put(COL_CREATED_AT_MS, createdAtMs)
            put(COL_UPDATED_AT_MS, updatedAtMs)
        }
        db.insertWithOnConflict(TABLE_JOBS, null, values, SQLiteDatabase.CONFLICT_REPLACE)
    }

    private fun getJobByIdInternal(db: SQLiteDatabase, id: String): BackgroundJobRecord? {
        return db.query(
            TABLE_JOBS,
            null,
            "$COL_ID = ?",
            arrayOf(id),
            null,
            null,
            null,
            "1",
        ).use { cursor ->
            mapCursor(cursor).firstOrNull()
        }
    }

    private fun getJobsByIdsInternal(db: SQLiteDatabase, ids: List<String>): List<BackgroundJobRecord> {
        if (ids.isEmpty()) return emptyList()
        val placeholders = ids.joinToString(",") { "?" }
        return db.query(
            TABLE_JOBS,
            null,
            "$COL_ID IN ($placeholders)",
            ids.toTypedArray(),
            null,
            null,
            "$COL_RUN_AT_MS ASC",
        ).use { cursor ->
            mapCursor(cursor)
        }
    }

    private fun mapCursor(cursor: Cursor): List<BackgroundJobRecord> {
        val idIndex = cursor.getColumnIndexOrThrow(COL_ID)
        val typeIndex = cursor.getColumnIndexOrThrow(COL_TYPE)
        val payloadIndex = cursor.getColumnIndexOrThrow(COL_PAYLOAD_JSON)
        val statusIndex = cursor.getColumnIndexOrThrow(COL_STATUS)
        val runAtIndex = cursor.getColumnIndexOrThrow(COL_RUN_AT_MS)
        val leaseUntilIndex = cursor.getColumnIndexOrThrow(COL_LEASE_UNTIL_MS)
        val attemptsIndex = cursor.getColumnIndexOrThrow(COL_ATTEMPTS)
        val maxAttemptsIndex = cursor.getColumnIndexOrThrow(COL_MAX_ATTEMPTS)
        val lastErrorIndex = cursor.getColumnIndexOrThrow(COL_LAST_ERROR)
        val createdAtIndex = cursor.getColumnIndexOrThrow(COL_CREATED_AT_MS)
        val updatedAtIndex = cursor.getColumnIndexOrThrow(COL_UPDATED_AT_MS)

        val rows = mutableListOf<BackgroundJobRecord>()
        while (cursor.moveToNext()) {
            rows.add(
                BackgroundJobRecord(
                    id = cursor.getString(idIndex),
                    type = cursor.getString(typeIndex),
                    payloadJson = cursor.getString(payloadIndex) ?: "{}",
                    status = cursor.getString(statusIndex),
                    runAtMs = cursor.getLong(runAtIndex),
                    leaseUntilMs =
                        if (cursor.isNull(leaseUntilIndex)) null else cursor.getLong(leaseUntilIndex),
                    attempts = cursor.getInt(attemptsIndex),
                    maxAttempts = cursor.getInt(maxAttemptsIndex),
                    lastError =
                        if (cursor.isNull(lastErrorIndex)) null else cursor.getString(lastErrorIndex),
                    createdAtMs = cursor.getLong(createdAtIndex),
                    updatedAtMs = cursor.getLong(updatedAtIndex),
                ),
            )
        }
        return rows
    }
}
