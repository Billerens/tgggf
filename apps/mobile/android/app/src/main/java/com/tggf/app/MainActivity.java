package com.tggf.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;
import com.tggf.app.localapi.ForegroundSyncService;
import com.tggf.app.localapi.LocalApiBridgePlugin;

public class MainActivity extends BridgeActivity {
    private static final int NOTIFICATION_PERMISSION_REQUEST_CODE = 7002;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Enable WebView remote debugging for easier diagnostics via chrome://inspect.
        WebView.setWebContentsDebuggingEnabled(true);
        registerPlugin(LocalApiBridgePlugin.class);
        super.onCreate(savedInstanceState);
        requestNotificationPermissionIfNeeded();
        ForegroundSyncService.ensureStartedIfEnabled(this);
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
