package com.tggf.app.localapi

import android.database.sqlite.SQLiteOpenHelper

internal fun SQLiteOpenHelper.closeQuietly() {
    try {
        close()
    } catch (_: Exception) {
        // Best-effort close in lifecycle/background paths.
    }
}
