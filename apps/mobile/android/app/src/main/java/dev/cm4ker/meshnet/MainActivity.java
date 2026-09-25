package dev.cm4ker.meshnet;

import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.Display;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    /** When the page was last brought back after its renderer went; a second loss soon after is not. */
    private static long pageRestored = 0;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plugins that live in this app rather than in a package are registered by hand, before the bridge starts.
        registerPlugin(MeshTcpPlugin.class);
        registerPlugin(SystemTextPlugin.class);
        registerPlugin(NoticesPlugin.class);
        registerPlugin(MeshRelayPlugin.class);
        super.onCreate(savedInstanceState);

        // The page draws its text at the system's size itself (SystemTextPlugin); the WebView scaling
        // it as well would apply the setting twice.
        WebView view = getBridge() != null ? getBridge().getWebView() : null;
        if (view != null) view.getSettings().setTextZoom(100);

        // The page's renderer is a process of its own, which Android lowers to a cached one once the
        // app is out of sight: the first a phone short of memory kills. Held as important, it keeps
        // the app's own standing, which the link's foreground service keeps high.
        if (view != null) view.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        if (getBridge() != null) {
            getBridge().addWebViewListener(new WebViewListener() {
                @Override
                public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                    return pageGone(webView, detail);
                }
            });
        }

        preferFastestRefresh();

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

    // The radio core announces what arrives while the page is out of sight and asleep; in front, the page does.
    @Override
    public void onStart() {
        super.onStart();
        MeshRelay.shared(this).setBackground(false);
    }

    @Override
    public void onStop() {
        super.onStop();
        MeshRelay.shared(this).setBackground(true);
    }

    /**
     * The page's renderer is gone, killed for memory or crashed. Left unhandled, Android ends the whole
     * app with it, and the link to the radio, its service and the radio core's notices go too. The
     * page is made anew instead, and finds the link where it left it.
     */
    private boolean pageGone(WebView webView, RenderProcessGoneDetail detail) {
        boolean crashed = detail != null && detail.didCrash();
        Log.w("MeshRelay", "the page's renderer is gone" + (crashed ? ", crashed" : ", killed"));
        AppExits.notePage(this, crashed);
        long now = SystemClock.elapsedRealtime();
        // A page that loses its renderer again at once would only go round; let the app end as before.
        if (pageRestored != 0 && now - pageRestored < 10_000) return false;
        pageRestored = now;
        // A WebView whose renderer is gone cannot be used again: out of the window, and destroyed.
        if (webView.getParent() instanceof ViewGroup) ((ViewGroup) webView.getParent()).removeView(webView);
        webView.destroy();
        new Handler(Looper.getMainLooper()).post(this::recreate);
        return true;
    }

    /**
     * Asks for the panel's fastest mode at the current resolution. Some vendors (ColorOS, for one)
     * hold an app they do not know at 60 Hz on a 120 Hz screen, and every scroll and sheet then
     * moves at half the rate the rest of the phone does.
     */
    private void preferFastestRefresh() {
        Display display = getWindowManager().getDefaultDisplay();
        Display.Mode current = display.getMode();
        Display.Mode best = current;
        for (Display.Mode mode : display.getSupportedModes()) {
            if (mode.getPhysicalWidth() == current.getPhysicalWidth()
                    && mode.getPhysicalHeight() == current.getPhysicalHeight()
                    && mode.getRefreshRate() > best.getRefreshRate()) {
                best = mode;
            }
        }
        WindowManager.LayoutParams params = getWindow().getAttributes();
        params.preferredDisplayModeId = best.getModeId();
        getWindow().setAttributes(params);
    }

    /** True when the page took the step; false, or anything else, lets the app go. */
    private static final String BACK =
        "(function(){try{var m=window.meshnet;return !!(m&&m.back&&m.back());}catch(e){return false;}})()";
}
