package com.tggf.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.WebView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;
import com.tggf.app.localapi.ForegroundSyncService;
import com.tggf.app.localapi.LocalApiBridgePlugin;
import java.lang.ref.WeakReference;

public class MainActivity extends BridgeActivity {
    private static final int NOTIFICATION_PERMISSION_REQUEST_CODE = 7002;
    private static final String TAG = "tg-gf/MainActivity";
    private static final Handler MAIN_HANDLER = new Handler(Looper.getMainLooper());
    private static WeakReference<MainActivity> activeInstance = new WeakReference<>(null);

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LocalApiBridgePlugin.class);
        super.onCreate(savedInstanceState);
        activeInstance = new WeakReference<>(this);
        enableWebViewDebugging("onCreate");
        promoteWebViewRendererPriority("onCreate");
        requestNotificationPermissionIfNeeded();
        ForegroundSyncService.ensureStartedIfEnabled(this);
    }

    @Override
    public void onResume() {
        super.onResume();
        activeInstance = new WeakReference<>(this);
        // Some devices/WebView updates can reset this flag; enforce it again.
        enableWebViewDebugging("onResume");
        promoteWebViewRendererPriority("onResume");
    }

    @Override
    public void onDestroy() {
        MainActivity current = activeInstance.get();
        if (current == this) {
            activeInstance = new WeakReference<>(null);
        }
        super.onDestroy();
    }

    private void enableWebViewDebugging(String reason) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.KITKAT) {
            return;
        }
        WebView.setWebContentsDebuggingEnabled(true);
        Log.i(TAG, "WebView debugging enabled (" + reason + ")");
    }

    private void promoteWebViewRendererPriority(String reason) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        if (getBridge() == null || getBridge().getWebView() == null) {
            return;
        }
        try {
            getBridge()
                .getWebView()
                .setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
            Log.i(TAG, "WebView renderer priority set to IMPORTANT (" + reason + ")");
        } catch (Throwable ex) {
            Log.w(TAG, "Unable to set WebView renderer priority (" + reason + ")", ex);
        }
    }

    private void pulseWebViewFromUiThread(String reason) {
        if (getBridge() == null || getBridge().getWebView() == null) {
            return;
        }
        try {
            WebView webView = getBridge().getWebView();
            webView.onResume();
            webView.resumeTimers();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
            }
            webView.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('tggf-native-pulse'));",
                null
            );
        } catch (Throwable ex) {
            Log.w(TAG, "Unable to pulse WebView (" + reason + ")", ex);
        }
    }

    public static boolean pulseWebViewFromService(String reason) {
        MainActivity activity = activeInstance.get();
        if (activity == null) {
            return false;
        }
        MAIN_HANDLER.post(() -> activity.pulseWebViewFromUiThread(reason));
        return true;
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
