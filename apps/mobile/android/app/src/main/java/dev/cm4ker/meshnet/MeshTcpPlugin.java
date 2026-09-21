package dev.cm4ker.meshnet;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * A TCP link to a radio on the network: {@code window.Capacitor.Plugins.MeshTcp},
 * the same plugin the iOS app carries (MeshTcpPlugin.swift), used by the web
 * client's {@code transports/capacitorTcp.ts}. Companion firmware built with Wi-Fi
 * listens on a port (5000 unless built otherwise) and speaks the framed stream
 * of its USB serial; the framing is the client's, this only moves bytes.
 *
 * <p>{@code open({host, port, timeout})} answers {@code {id}}; {@code write({id, data})}
 * takes base64; {@code close({id})}. Events: {@code data {id, data}} as bytes arrive, and
 * {@code closed {id, error}} when a connection ends without being closed from here.
 */
@CapacitorPlugin(name = "MeshTcp")
public class MeshTcpPlugin extends Plugin {
    private final Map<String, Socket> sockets = new ConcurrentHashMap<>();
    /** Connects and reads, one thread per connection. */
    private final ExecutorService readers = Executors.newCachedThreadPool();
    /** Writes, one at a time, so frames go out in the order they were sent. */
    private final ExecutorService writer = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void open(PluginCall call) {
        String host = call.getString("host", "").trim();
        int port = call.getInt("port", 5000);
        double timeout = call.getDouble("timeout", 10.0);
        if (host.isEmpty()) {
            call.reject("an address is needed");
            return;
        }
        if (port <= 0 || port >= 65536) {
            call.reject(port + " is not a port");
            return;
        }
        String address = host + ":" + port;
        readers.execute(() -> {
            Socket socket = new Socket();
            try {
                socket.setTcpNoDelay(true);
                socket.setKeepAlive(true);
                socket.connect(new InetSocketAddress(host, port), (int) (timeout * 1000));
            } catch (IOException e) {
                closeQuietly(socket);
                call.reject(address + " did not answer: " + e.getMessage());
                return;
            }
            String id = UUID.randomUUID().toString();
            sockets.put(id, socket);
            JSObject result = new JSObject();
            result.put("id", id);
            call.resolve(result);
            read(id, socket);
        });
    }

    @PluginMethod
    public void write(PluginCall call) {
        String id = call.getString("id", "");
        String data = call.getString("data");
        if (data == null) {
            call.reject("write needs base64 data");
            return;
        }
        byte[] bytes = Base64.decode(data, Base64.DEFAULT);
        writer.execute(() -> {
            Socket socket = sockets.get(id);
            if (socket == null) {
                call.reject("not connected");
                return;
            }
            try {
                OutputStream out = socket.getOutputStream();
                out.write(bytes);
                out.flush();
                call.resolve();
            } catch (IOException e) {
                call.reject(e.getMessage());
            }
        });
    }

    @PluginMethod
    public void close(PluginCall call) {
        Socket socket = sockets.remove(call.getString("id", ""));
        if (socket != null) closeQuietly(socket);
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        for (Socket socket : sockets.values()) closeQuietly(socket);
        sockets.clear();
        readers.shutdownNow();
        writer.shutdownNow();
    }

    private void read(String id, Socket socket) {
        byte[] buffer = new byte[4096];
        String reason = "the radio closed the connection";
        try {
            InputStream in = socket.getInputStream();
            int n;
            while ((n = in.read(buffer)) > 0) {
                JSObject event = new JSObject();
                event.put("id", id);
                event.put("data", Base64.encodeToString(buffer, 0, n, Base64.NO_WRAP));
                notifyListeners("data", event);
            }
        } catch (IOException e) {
            reason = e.getMessage();
        }
        // A socket closed from here is already out of the table, and says nothing.
        if (sockets.remove(id) == null) return;
        closeQuietly(socket);
        JSObject event = new JSObject();
        event.put("id", id);
        event.put("error", reason);
        notifyListeners("closed", event);
    }

    private static void closeQuietly(Socket socket) {
        try {
            socket.close();
        } catch (IOException ignored) {
            // Already closed.
        }
    }
}
