package com.tggf.app.localapi

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootRecoveryReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val appContext = context.applicationContext
        val action = intent?.action.orEmpty()
        if (
            action != Intent.ACTION_BOOT_COMPLETED &&
                action != Intent.ACTION_MY_PACKAGE_REPLACED
        ) {
            return
        }

        BackgroundScheduler.ensureScheduled(appContext, "boot_recovery:$action")
        ForegroundSyncService.ensureStartedIfEnabled(appContext)
        BackgroundRuntimeEngine.requestTick(appContext)
        TopicGenerationNativeExecutor.requestTick(appContext)
        GroupIterationNativeExecutor.requestTick(appContext)
    }
}

