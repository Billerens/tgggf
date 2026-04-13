package com.tggf.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.tggf.app.localapi.LocalApiBridgePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LocalApiBridgePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
