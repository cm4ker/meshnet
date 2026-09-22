package dev.cm4ker.meshnet;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plugins that live in this app rather than in a package are registered by hand, before the bridge starts.
        registerPlugin(MeshTcpPlugin.class);
        registerPlugin(SystemTextPlugin.class);
        super.onCreate(savedInstanceState);

        // The page draws its text at the system's size itself (SystemTextPlugin); the WebView scaling
        // it as well would apply the setting twice.
        WebView view = getBridge() != null ? getBridge().getWebView() : null;
        if (view != null) view.getSettings().setTextZoom(100);

        // Back is the page's to take (back.ts): it closes a sheet or a dialog, then a screen, then
        // returns to Chats. Only when it has no step left does Back leave the app, as Android's own
        // apps do. Asked directly rather than through the WebView's history: Chromium may skip an
        // entry a page added without a tap, and then Back leaves the app from a screen still open.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView web = getBridge() != null ? getBridge().getWebView() : null;
                if (web == null) {
                    leave();
                    return;
                }
                web.evaluateJavascript(BACK, (taken) -> {
                    if (!"true".equals(taken)) leave();
                });
            }

            private void leave() {
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
                setEnabled(true);
            }
        });
    }

    /** True when the page took the step; false, or anything else, lets the app go. */
    private static final String BACK =
        "(function(){try{var m=window.meshnet;return !!(m&&m.back&&m.back());}catch(e){return false;}})()";
}
