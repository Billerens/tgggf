package com.tggf.app;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.view.WindowManager;
import android.webkit.WebView;
import android.widget.FrameLayout;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;
import com.tggf.app.localapi.BackgroundScheduler;
import com.tggf.app.localapi.ForegroundSyncService;
import com.tggf.app.localapi.LocalApiBridgePlugin;
import java.lang.ref.WeakReference;

public class MainActivity extends BridgeActivity {
    private static final int NOTIFICATION_PERMISSION_REQUEST_CODE = 7002;
    private static final String TAG = "tg-gf/MainActivity";
    private static final String EXTRA_TARGET_TYPE = "targetType";
    private static final String EXTRA_TARGET_ID = "targetId";
    private static final Handler MAIN_HANDLER = new Handler(Looper.getMainLooper());
    private static WeakReference<MainActivity> activeInstance = new WeakReference<>(null);
    private static final Object launchTargetLock = new Object();
    private static volatile boolean appInForeground = false;
    private static String pendingTargetType = null;
    private static String pendingTargetId = null;
    private View privacyShieldView = null;
    private boolean privacyShieldEnabled = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LocalApiBridgePlugin.class);
        super.onCreate(savedInstanceState);
        activeInstance = new WeakReference<>(this);
        enableWebViewDebugging("onCreate");
        promoteWebViewRendererPriority("onCreate");
        requestNotificationPermissionIfNeeded();
        BackgroundScheduler.ensureScheduled(this, "activity_on_create");
        ForegroundSyncService.ensureStartedIfEnabled(this);
        captureLaunchTarget(getIntent());
    }

    @Override
    public void onResume() {
        super.onResume();
        activeInstance = new WeakReference<>(this);
        appInForeground = true;
        disablePrivacyShield("onResume");
        // Some devices/WebView updates can reset this flag; enforce it again.
        enableWebViewDebugging("onResume");
        promoteWebViewRendererPriority("onResume");
    }

    @Override
    public void onPause() {
        appInForeground = false;
        enablePrivacyShield("onPause");
        super.onPause();
    }

    @Override
    public void onStop() {
        appInForeground = false;
        enablePrivacyShield("onStop");
        super.onStop();
    }

    @Override
    public void onDestroy() {
        disablePrivacyShield("onDestroy");
        MainActivity current = activeInstance.get();
        if (current == this) {
            activeInstance = new WeakReference<>(null);
        }
        appInForeground = false;
        super.onDestroy();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        captureLaunchTarget(intent);
    }

    public static boolean isAppInForeground() {
        return appInForeground;
    }

    public static String[] consumePendingLaunchTarget() {
        synchronized (launchTargetLock) {
            if (pendingTargetType == null || pendingTargetType.trim().isEmpty()) {
                pendingTargetType = null;
                pendingTargetId = null;
                return null;
            }
            if (pendingTargetId == null || pendingTargetId.trim().isEmpty()) {
                pendingTargetType = null;
                pendingTargetId = null;
                return null;
            }
            String[] result = new String[] { pendingTargetType, pendingTargetId };
            pendingTargetType = null;
            pendingTargetId = null;
            return result;
        }
    }

    private void captureLaunchTarget(Intent intent) {
        if (intent == null) return;
        String targetType = intent.getStringExtra(EXTRA_TARGET_TYPE);
        String targetId = intent.getStringExtra(EXTRA_TARGET_ID);
        if (targetType == null) return;
        if (targetId == null) return;
        String normalizedType = targetType.trim().toLowerCase();
        String normalizedId = targetId.trim();
        if (normalizedId.isEmpty()) return;
        if (!"chat".equals(normalizedType) && !"group".equals(normalizedType)) {
            return;
        }
        synchronized (launchTargetLock) {
            pendingTargetType = normalizedType;
            pendingTargetId = normalizedId;
        }
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

    private void enablePrivacyShield(String reason) {
        if (privacyShieldEnabled) {
            return;
        }
        try {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
            ViewGroup container = resolvePrivacyShieldContainer();
            if (container == null) {
                privacyShieldEnabled = true;
                Log.i(TAG, "Privacy shield enabled without overlay (" + reason + ")");
                return;
            }
            FrameLayout shield = new FrameLayout(this);
            shield.setLayoutParams(
                new ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
            );
            shield.setBackgroundColor(Color.BLACK);
            shield.setClickable(true);
            shield.setFocusable(true);
            container.addView(shield);
            privacyShieldView = shield;
            privacyShieldEnabled = true;
            Log.i(TAG, "Privacy shield enabled (" + reason + ")");
        } catch (Throwable ex) {
            Log.w(TAG, "Unable to enable privacy shield (" + reason + ")", ex);
        }
    }

    private void disablePrivacyShield(String reason) {
        if (!privacyShieldEnabled && privacyShieldView == null) {
            return;
        }
        try {
            View view = privacyShieldView;
            if (view != null) {
                ViewParent parent = view.getParent();
                if (parent instanceof ViewGroup) {
                    ((ViewGroup) parent).removeView(view);
                }
            }
            privacyShieldView = null;
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
            privacyShieldEnabled = false;
            Log.i(TAG, "Privacy shield disabled (" + reason + ")");
        } catch (Throwable ex) {
            Log.w(TAG, "Unable to disable privacy shield (" + reason + ")", ex);
        }
    }

    private ViewGroup resolvePrivacyShieldContainer() {
        if (getBridge() != null && getBridge().getWebView() != null) {
            ViewParent parent = getBridge().getWebView().getParent();
            if (parent instanceof ViewGroup) {
                return (ViewGroup) parent;
            }
        }
        View decor = getWindow().getDecorView();
        if (decor instanceof ViewGroup) {
            return (ViewGroup) decor;
        }
        return null;
    }
}
