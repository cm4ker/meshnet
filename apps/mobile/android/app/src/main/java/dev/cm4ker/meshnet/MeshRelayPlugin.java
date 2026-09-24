package dev.cm4ker.meshnet;

import android.Manifest;
import android.os.Build;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * The page's side of the relay ({@link MeshRelay}), the same plugin the iOS app carries, used by
 * the web client's {@code lib/relay.ts}: {@code start({ deviceId, name })} with the radio the page
 * is connected to, {@code stop()}, {@code state()}, and a {@code state} event
 * {@code { on, computer }} whenever a computer comes or goes. While {@code attach()}ed, the page
 * talks to the radio through here: {@code send({ data })} (base64), answered once the frame has
 * gone to the radio, and {@code frame} events {@code { data }}.
 *
 * <p>Advertising to a computer takes Bluetooth's "nearby devices" permission for advertising on
 * Android 12 and later, asked on the first start.
 */
@CapacitorPlugin(
    name = "MeshRelay",
    permissions = { @Permission(alias = MeshRelayPlugin.ADVERTISE, strings = { Manifest.permission.BLUETOOTH_ADVERTISE }) }
)
public class MeshRelayPlugin extends Plugin {
    static final String ADVERTISE = "advertise";

    private MeshRelay relay() {
        return MeshRelay.shared(getContext());
    }

    @Override
    public void load() {
        relay().setListener(new MeshRelay.Listener() {
            @Override
            public void changed(boolean on, boolean computer) {
                notifyListeners("state", state(on, computer));
            }

            @Override
            public void pageFrame(byte[] frame) {
                JSObject event = new JSObject();
                event.put("data", Base64.encodeToString(frame, Base64.NO_WRAP));
                notifyListeners("frame", event);
            }
        });
    }

    private static JSObject state(boolean on, boolean computer) {
        JSObject state = new JSObject();
        state.put("on", on);
        state.put("computer", computer);
        return state;
    }

    private JSObject state() {
        return state(relay().isOn(), relay().hasComputer());
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (call.getString("deviceId", "").isEmpty()) {
            call.reject("start needs the radio's deviceId");
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && getPermissionState(ADVERTISE) != PermissionState.GRANTED) {
            requestPermissionForAlias(ADVERTISE, call, "startAllowed");
            return;
        }
        begin(call);
    }

    @PermissionCallback
    private void startAllowed(PluginCall call) {
        if (getPermissionState(ADVERTISE) != PermissionState.GRANTED) {
            call.reject("Allow nearby devices for Ommesh to share the radio with a computer");
            return;
        }
        begin(call);
    }

    private void begin(PluginCall call) {
        String address = call.getString("deviceId", "");
        getActivity().runOnUiThread(() -> {
            relay().start(address);
            call.resolve(state());
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            relay().stop();
            call.resolve(state());
        });
    }

    @PluginMethod
    public void state(PluginCall call) {
        getActivity().runOnUiThread(() -> call.resolve(state()));
    }

    @PluginMethod
    public void attach(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            relay().attachPage();
            call.resolve();
        });
    }

    @PluginMethod
    public void detach(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            relay().detachPage();
            call.resolve();
        });
    }

    @PluginMethod
    public void send(PluginCall call) {
        String data = call.getString("data");
        byte[] frame;
        try {
            frame = data == null ? null : Base64.decode(data, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            frame = null;
        }
        if (frame == null) {
            call.reject("send needs base64 data");
            return;
        }
        byte[] bytes = frame;
        getActivity().runOnUiThread(() -> relay().fromPage(bytes, call::resolve));
    }
}
