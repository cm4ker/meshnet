package dev.cm4ker.meshnet;

import android.content.Intent;
import android.provider.Settings;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The system's notification settings for this app, for the web client's
 * {@code lib/notify.ts}: {@code window.Capacitor.Plugins.Notices}. Sound, vibration and
 * quiet hours belong to Android, one line per channel (direct messages, channels and
 * rooms, new nodes), so the page opens that screen instead of copying it.
 */
@CapacitorPlugin(name = "Notices")
public class NoticesPlugin extends Plugin {
    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName())
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }
}
