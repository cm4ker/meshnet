package dev.cm4ker.meshnet;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plugins that live in this app rather than in a package are registered by hand, before the bridge starts.
        registerPlugin(MeshTcpPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
