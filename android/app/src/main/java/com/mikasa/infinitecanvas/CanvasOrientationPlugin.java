package com.mikasa.infinitecanvas;

import android.app.Activity;
import android.content.pm.ActivityInfo;
import android.os.Build;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "CanvasOrientation")
public class CanvasOrientationPlugin extends Plugin {
    private int requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
    private int systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE;
    private boolean stateCaptured = false;

    @PluginMethod
    public void enter(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activity is unavailable");
            return;
        }

        activity.runOnUiThread(() -> {
            try {
                if (!stateCaptured) {
                    requestedOrientation = activity.getRequestedOrientation();
                    systemUiVisibility = activity.getWindow().getDecorView().getSystemUiVisibility();
                    stateCaptured = true;
                }
                activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
                hideSystemBars(activity);
                call.resolve();
            } catch (Exception error) {
                call.reject("Unable to enter canvas landscape mode", error);
            }
        });
    }

    @PluginMethod
    public void exit(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activity is unavailable");
            return;
        }

        activity.runOnUiThread(() -> {
            try {
                if (stateCaptured) {
                    activity.setRequestedOrientation(requestedOrientation);
                    showSystemBars(activity);
                    activity.getWindow().getDecorView().setSystemUiVisibility(systemUiVisibility);
                    stateCaptured = false;
                }
                call.resolve();
            } catch (Exception error) {
                call.reject("Unable to restore screen orientation", error);
            }
        });
    }

    private void hideSystemBars(Activity activity) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = activity.getWindow().getInsetsController();
            if (controller != null) {
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                controller.hide(WindowInsets.Type.systemBars());
            }
            return;
        }

        activity.getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
        );
    }

    private void showSystemBars(Activity activity) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = activity.getWindow().getInsetsController();
            if (controller != null) {
                controller.show(WindowInsets.Type.systemBars());
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_DEFAULT);
            }
        }
    }
}
