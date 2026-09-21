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
        super.onCreate(savedInstanceState);

        // The client keeps a history entry while a screen is open over a section's root, so Back
        // closes that screen; only at a root does Back leave the app, as Android's own apps do.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView web = getBridge() != null ? getBridge().getWebView() : null;
                if (web != null && web.canGoBack()) {
                    web.goBack();
                    return;
                }
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
                setEnabled(true);
            }
        });
    }
}
