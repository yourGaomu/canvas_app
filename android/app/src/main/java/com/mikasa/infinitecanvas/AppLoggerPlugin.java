package com.mikasa.infinitecanvas;

import android.content.pm.ApplicationInfo;
import android.util.Log;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.PluginMethod;

@CapacitorPlugin(name = "AppLogger")
public class AppLoggerPlugin extends Plugin {
    @PluginMethod
    public void write(PluginCall call) {
        if ((getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) == 0) {
            call.resolve();
            return;
        }
        String level = call.getString("level", "info");
        String message = call.getString("message", "");
        int priority = "error".equals(level) ? Log.ERROR : "warn".equals(level) ? Log.WARN : Log.INFO;
        Log.println(priority, "mikasa-app", message.length() > 4000 ? message.substring(0, 4000) : message);
        call.resolve();
    }
}
