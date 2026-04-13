package com.tggf.app;

import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.tggf.app.localapi.ForegroundSyncService;
import com.tggf.app.localapi.LocalApiBridgePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Enable WebView remote debugging for easier diagnostics via chrome://inspect.
        WebView.setWebContentsDebuggingEnabled(true);
        registerPlugin(LocalApiBridgePlugin.class);
        super.onCreate(savedInstanceState);
        ForegroundSyncService.ensureStartedIfEnabled(this);
    }
}
