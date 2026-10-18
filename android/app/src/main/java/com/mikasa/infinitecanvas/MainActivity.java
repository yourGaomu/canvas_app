package com.mikasa.infinitecanvas;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(AppLoggerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
