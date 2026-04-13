package com.tggf.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.webkit.WebView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;
import com.tggf.app.localapi.ForegroundSyncService;
import com.tggf.app.localapi.LocalApiBridgePlugin;

public class MainActivity extends BridgeActivity {
    private static final int NOTIFICATION_PERMISSION_REQUEST_CODE = 7002;
    private static final String TAG = "tg-gf/MainActivity";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LocalApiBridgePlugin.class);
        super.onCreate(savedInstanceState);
        enableWebViewDebugging("onCreate");
        requestNotificationPermissionIfNeeded();
        ForegroundSyncService.ensureStartedIfEnabled(this);
    }

    @Override
    public void onResume() {
        super.onResume();
        // Some devices/WebView updates can reset this flag; enforce it again.
        enableWebViewDebugging("onResume");
    }

    private void enableWebViewDebugging(String reason) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.KITKAT) {
            return;
        }
        WebView.setWebContentsDebuggingEnabled(true);
        Log.i(TAG, "WebView debugging enabled (" + reason + ")");
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return;
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            == PackageManager.PERMISSION_GRANTED) {
            return;
        }
        ActivityCompat.requestPermissions(
            this,
            new String[]{Manifest.permission.POST_NOTIFICATIONS},
            NOTIFICATION_PERMISSION_REQUEST_CODE
        );
    }
}
