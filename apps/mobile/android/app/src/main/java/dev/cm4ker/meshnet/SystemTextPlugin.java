package dev.cm4ker.meshnet;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The system's text size, for the web client's {@code theme/textSize.ts}:
 * {@code window.Capacitor.Plugins.SystemText}. {@code scale()} answers {@code {scale}},
 * the font scale from Android's display settings, 1 at the default size. The page
 * draws its text at that share itself, so the WebView is told not to scale text on
 * its own (MainActivity), and the setting is not applied twice.
 */
@CapacitorPlugin(name = "SystemText")
public class SystemTextPlugin extends Plugin {
    @PluginMethod
    public void scale(PluginCall call) {
        JSObject result = new JSObject();
        result.put("scale", (double) getContext().getResources().getConfiguration().fontScale);
        call.resolve(result);
    }
}
