package dev.cm4ker.meshnet;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattServer;
import android.bluetooth.BluetoothGattServerCallback;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.BluetoothStatusCodes;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.util.Base64;
import android.util.Log;
import java.io.ByteArrayOutputStream;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Shares the radio with a computer nearby, through the phone: the Android side of the iOS
 * app's {@code MeshRelay.swift}.
 *
 * <p>The phone serves the same UART service the radio does (Nordic UART, {@code 6E400001…}),
 * so a computer connects to the phone as if it were the radio, with the client it already has.
 * The page talks to the radio through here too, and {@link RelayMux} decides whose command goes
 * to the radio when and whose an answer is, so both use the radio at once. The framing is BLE's
 * own, one frame per write or notification.
 *
 * <p>The radio is held by this object's own GATT client, on the link the BLE plugin already
 * made: Android shares one link between the clients on it. The page's plugin stays connected (it
 * is how the page learns of a drop) but the page's frames come and go through here. While on,
 * {@link MeshRelayService} keeps the app running in the background.
 *
 * <p>Both characteristics demand an encrypted link, so a computer has to be paired with the
 * phone first: Android asks on its own screen. Android advertises under the phone's own
 * Bluetooth name, which is what the computer lists.
 *
 * <p>Everything runs on the main thread; the Bluetooth callbacks hop there first.
 */
@SuppressLint("MissingPermission") // The plugin asks for Bluetooth before start().
final class MeshRelay {
    private static final String TAG = "MeshRelay";
    private static final UUID SERVICE = UUID.fromString("6E400001-B5A3-F393-E0A9-E50E24DCCA9E");
    private static final UUID RX = UUID.fromString("6E400002-B5A3-F393-E0A9-E50E24DCCA9E");
    private static final UUID TX = UUID.fromString("6E400003-B5A3-F393-E0A9-E50E24DCCA9E");
    private static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
    private static final String PREFS = "meshnet.relay";
    private static final String INBOXES_KEY = "inboxes";

    interface Listener {
        /** Every change: whether sharing is on, and whether a computer is connected. */
        void changed(boolean on, boolean computer);

        void pageFrame(byte[] frame);
    }

    @SuppressLint("StaticFieldLeak") // The application context, which lives as long as the process.
    private static MeshRelay shared;

    static MeshRelay shared(Context context) {
        if (shared == null) shared = new MeshRelay(context.getApplicationContext());
        return shared;
    }

    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final RelayMux mux;
    private Listener listener;

    private BluetoothGattServer server;
    private BluetoothGattCharacteristic served;
    private boolean published = false;
    private boolean advertising = false;

    private String radioAddress;
    private BluetoothGatt radio;
    private BluetoothGattCharacteristic radioRx;
    /** Frames for the radio; Android takes one GATT operation at a time. */
    private final ArrayDeque<byte[]> radioWrites = new ArrayDeque<>();
    private boolean radioWriting = false;
    /** Discovery goes on after this if the MTU exchange never answers. */
    private final Runnable mtuTimeout = () -> {
        if (radio != null && radioRx == null) radio.discoverServices();
    };
    /** Discoveries that came back without the UART service; tried again a few times, a second apart. */
    private int discoveries = 0;
    private final Runnable rediscover = () -> {
        if (radio != null && radioRx == null) radio.discoverServices();
    };

    private BluetoothDevice computer;
    private int computerMtu = 23;
    /** Notifications for the computer, one at a time: the next goes when Android says the last went. */
    private final ArrayDeque<byte[]> backlog = new ArrayDeque<>();
    private boolean notifying = false;
    /** Tries of the frame at the head of a queue Android turned away; it is dropped after {@link #TRIES}. */
    private int notifyTries = 0;
    private int writeTries = 0;
    private static final int TRIES = 50;
    /** A long write from the computer, in pieces, until it is executed. */
    private final ByteArrayOutputStream prepared = new ByteArrayOutputStream();

    private boolean watchingAdapter = false;

    private MeshRelay(Context context) {
        this.context = context;
        mux = new RelayMux(loadInboxes());
        mux.toRadio = this::writeRadio;
        mux.toClient = (client, frame) -> {
            if (client == RelayMux.Client.COMPUTER) {
                toComputer(frame);
            } else if (listener != null) {
                listener.pageFrame(frame);
            }
        };
        mux.timers = (millis, block) -> main.postDelayed(block, millis);
        mux.inboxesChanged = this::saveInboxes;
        mux.log = (line) -> Log.w(TAG, line);
    }

    void setListener(Listener listener) {
        this.listener = listener;
    }

    boolean isOn() {
        return radioAddress != null;
    }

    boolean hasComputer() {
        return computer != null;
    }

    private void changed() {
        if (listener != null) listener.changed(isOn(), hasComputer());
        if (isOn()) MeshRelayService.update(context, hasComputer());
    }

    // The inboxes outlive the app: the radio's copy of a message is gone once the relay has read it.

    private Map<RelayMux.Client, List<byte[]>> loadInboxes() {
        Map<RelayMux.Client, List<byte[]>> inboxes = new EnumMap<>(RelayMux.Client.class);
        String text = prefs().getString(INBOXES_KEY, null);
        if (text == null) return inboxes;
        try {
            JSONObject saved = new JSONObject(text);
            for (RelayMux.Client client : RelayMux.Client.values()) {
                JSONArray frames = saved.optJSONArray(client.key);
                if (frames == null) continue;
                List<byte[]> list = new ArrayList<>();
                for (int i = 0; i < frames.length(); i++) list.add(Base64.decode(frames.getString(i), Base64.NO_WRAP));
                inboxes.put(client, list);
            }
        } catch (JSONException | IllegalArgumentException e) {
            Log.w(TAG, "the saved inboxes could not be read", e);
        }
        return inboxes;
    }

    private void saveInboxes() {
        JSONObject saved = new JSONObject();
        try {
            for (Map.Entry<RelayMux.Client, List<byte[]>> inbox : mux.inboxes().entrySet()) {
                JSONArray frames = new JSONArray();
                for (byte[] frame : inbox.getValue()) frames.put(Base64.encodeToString(frame, Base64.NO_WRAP));
                saved.put(inbox.getKey().key, frames);
            }
        } catch (JSONException e) {
            Log.w(TAG, "the inboxes could not be saved", e);
            return;
        }
        prefs().edit().putString(INBOXES_KEY, saved.toString()).apply();
    }

    private SharedPreferences prefs() {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Starts serving, for the radio the page is connected to (the BLE plugin's id: its address). */
    void start(String address) {
        if (!address.equals(radioAddress)) {
            releaseRadio();
            radioAddress = address;
        }
        watchAdapter();
        MeshRelayService.start(context, hasComputer());
        attachRadio();
        publish();
        changed();
    }

    void stop() {
        radioAddress = null;
        unpublish();
        dropComputer();
        mux.detach(RelayMux.Client.PAGE);
        releaseRadio();
        MeshRelayService.stop(context);
        changed();
    }

    // The page

    void attachPage() {
        mux.attach(RelayMux.Client.PAGE);
    }

    void detachPage() {
        mux.detach(RelayMux.Client.PAGE);
    }

    /** {@code dispatched} is called once the frame has gone to the radio, or been answered here. */
    void fromPage(byte[] frame, Runnable dispatched) {
        if (!isOn()) {
            dispatched.run();
            return;
        }
        mux.fromClient(RelayMux.Client.PAGE, frame, dispatched);
    }

    // The computer's side

    private BluetoothManager manager() {
        return (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
    }

    private boolean poweredOn() {
        BluetoothManager manager = manager();
        BluetoothAdapter adapter = manager != null ? manager.getAdapter() : null;
        return adapter != null && adapter.isEnabled();
    }

    private void publish() {
        if (!isOn() || !poweredOn()) return;
        if (published) {
            advertise();
            return;
        }
        server = manager().openGattServer(context, serverCallback);
        if (server == null) {
            Log.w(TAG, "no GATT server");
            return;
        }
        BluetoothGattCharacteristic rx = new BluetoothGattCharacteristic(
            RX,
            BluetoothGattCharacteristic.PROPERTY_WRITE | BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
            BluetoothGattCharacteristic.PERMISSION_WRITE_ENCRYPTED
        );
        BluetoothGattCharacteristic tx = new BluetoothGattCharacteristic(
            TX,
            BluetoothGattCharacteristic.PROPERTY_NOTIFY,
            BluetoothGattCharacteristic.PERMISSION_READ_ENCRYPTED
        );
        tx.addDescriptor(new BluetoothGattDescriptor(
            CCCD,
            BluetoothGattDescriptor.PERMISSION_READ | BluetoothGattDescriptor.PERMISSION_WRITE_ENCRYPTED
        ));
        BluetoothGattService service = new BluetoothGattService(SERVICE, BluetoothGattService.SERVICE_TYPE_PRIMARY);
        service.addCharacteristic(rx);
        service.addCharacteristic(tx);
        served = tx;
        published = true;
        server.addService(service);
    }

    private void unpublish() {
        stopAdvertising();
        if (server != null) {
            if (computer != null) server.cancelConnection(computer);
            server.close();
        }
        server = null;
        served = null;
        published = false;
    }

    private BluetoothLeAdvertiser advertiser() {
        BluetoothManager manager = manager();
        BluetoothAdapter adapter = manager != null ? manager.getAdapter() : null;
        return adapter != null ? adapter.getBluetoothLeAdvertiser() : null;
    }

    /** Only while no computer is connected: this serves one, as the firmware does. */
    private void advertise() {
        if (!isOn() || !published || computer != null || advertising || !poweredOn()) return;
        BluetoothLeAdvertiser advertiser = advertiser();
        if (advertiser == null) {
            Log.w(TAG, "this phone cannot advertise");
            return;
        }
        AdvertiseSettings settings = new AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
            .setConnectable(true)
            .setTimeout(0)
            .build();
        // The 128-bit service takes most of the advert; the name, which the computer lists, goes in the scan response.
        AdvertiseData data = new AdvertiseData.Builder().addServiceUuid(new ParcelUuid(SERVICE)).build();
        AdvertiseData response = new AdvertiseData.Builder().setIncludeDeviceName(true).build();
        advertising = true;
        advertiser.startAdvertising(settings, data, response, advertiseCallback);
    }

    private void stopAdvertising() {
        if (!advertising) return;
        advertising = false;
        BluetoothLeAdvertiser advertiser = advertiser();
        if (advertiser != null && poweredOn()) advertiser.stopAdvertising(advertiseCallback);
    }

    private final AdvertiseCallback advertiseCallback = new AdvertiseCallback() {
        @Override
        public void onStartFailure(int errorCode) {
            main.post(() -> {
                if (errorCode == ADVERTISE_FAILED_ALREADY_STARTED) return;
                Log.w(TAG, "advertising failed: " + errorCode);
                advertising = false;
            });
        }
    };

    private void attachComputer(BluetoothDevice device) {
        Log.i(TAG, "computer subscribed: " + device.getAddress());
        if (computer != null && computer.equals(device)) return;
        computer = device;
        backlog.clear();
        notifying = false;
        stopAdvertising();
        mux.attach(RelayMux.Client.COMPUTER);
        attachRadio();
        changed();
    }

    private void dropComputer() {
        if (computer == null) return;
        computer = null;
        computerMtu = 23;
        backlog.clear();
        notifying = false;
        prepared.reset();
        mux.detach(RelayMux.Client.COMPUTER);
        advertise();
        changed();
    }

    private void toComputer(byte[] frame) {
        if (computer == null) return;
        backlog.add(frame);
        if (!notifying) sendNext();
    }

    @SuppressWarnings("deprecation") // setValue and the three-argument notify are what Android before 13 has.
    private void sendNext() {
        byte[] frame = backlog.poll();
        if (frame == null || server == null || served == null || computer == null) {
            notifying = false;
            return;
        }
        if (frame.length > computerMtu - 3) {
            Log.w(TAG, "a " + frame.length + "-byte frame does not fit the computer's MTU of " + computerMtu);
        }
        boolean queued;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            queued = server.notifyCharacteristicChanged(computer, served, false, frame) == BluetoothStatusCodes.SUCCESS;
        } else {
            served.setValue(frame);
            queued = server.notifyCharacteristicChanged(computer, served, false);
        }
        notifying = true;
        if (queued) {
            notifyTries = 0;
        } else if (++notifyTries < TRIES) {
            // Android is busy; tried again shortly.
            backlog.addFirst(frame);
            main.postDelayed(this::sendNext, 20);
        } else {
            Log.w(TAG, "a frame for the computer was dropped");
            notifyTries = 0;
            main.post(this::sendNext);
        }
    }

    private final BluetoothGattServerCallback serverCallback = new BluetoothGattServerCallback() {
        @Override
        public void onServiceAdded(int status, BluetoothGattService service) {
            main.post(() -> {
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    Log.w(TAG, "the service was not published: " + status);
                    published = false;
                    return;
                }
                advertise();
            });
        }

        @Override
        public void onConnectionStateChange(BluetoothDevice device, int status, int newState) {
            Log.i(TAG, "computer " + device.getAddress() + " state " + newState + " status " + status);
            main.post(() -> {
                if (newState == BluetoothProfile.STATE_DISCONNECTED && device.equals(computer)) dropComputer();
            });
        }

        @Override
        public void onMtuChanged(BluetoothDevice device, int mtu) {
            main.post(() -> {
                if (device.equals(computer) || computer == null) computerMtu = mtu;
            });
        }

        /** Nothing here is readable, but every request is answered: one left unanswered stalls the computer's discovery. */
        @Override
        public void onCharacteristicReadRequest(BluetoothDevice device, int requestId, int offset, BluetoothGattCharacteristic characteristic) {
            Log.i(TAG, "computer reads " + characteristic.getUuid());
            respond(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, new byte[0]);
        }

        @Override
        public void onDescriptorReadRequest(BluetoothDevice device, int requestId, int offset, BluetoothGattDescriptor descriptor) {
            Log.i(TAG, "computer reads descriptor " + descriptor.getUuid());
            byte[] value = device.equals(computer)
                ? BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                : BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE;
            respond(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, value);
        }

        @Override
        public void onDescriptorWriteRequest(
            BluetoothDevice device,
            int requestId,
            BluetoothGattDescriptor descriptor,
            boolean preparedWrite,
            boolean responseNeeded,
            int offset,
            byte[] value
        ) {
            Log.i(TAG, "computer writes descriptor " + descriptor.getUuid());
            if (responseNeeded) respond(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null);
            if (!CCCD.equals(descriptor.getUuid()) || !TX.equals(descriptor.getCharacteristic().getUuid())) return;
            boolean subscribed = value != null && value.length > 0 && (value[0] & 0x01) != 0;
            main.post(() -> {
                if (subscribed) {
                    attachComputer(device);
                } else if (device.equals(computer)) {
                    dropComputer();
                }
            });
        }

        @Override
        public void onCharacteristicWriteRequest(
            BluetoothDevice device,
            int requestId,
            BluetoothGattCharacteristic characteristic,
            boolean preparedWrite,
            boolean responseNeeded,
            int offset,
            byte[] value
        ) {
            Log.d(TAG, "computer writes " + (value == null ? 0 : value.length) + " bytes");
            if (responseNeeded) respond(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value);
            if (!RX.equals(characteristic.getUuid()) || value == null) return;
            main.post(() -> {
                if (!device.equals(computer)) return;
                if (preparedWrite) {
                    // A frame longer than the link's MTU comes as a long write, in pieces with offsets.
                    prepared.write(value, 0, value.length);
                } else if (value.length > 0) {
                    mux.fromClient(RelayMux.Client.COMPUTER, value, null);
                }
            });
        }

        @Override
        public void onExecuteWrite(BluetoothDevice device, int requestId, boolean execute) {
            Log.i(TAG, "computer executes a long write: " + execute);
            respond(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null);
            main.post(() -> {
                byte[] frame = prepared.toByteArray();
                prepared.reset();
                if (execute && frame.length > 0 && device.equals(computer)) mux.fromClient(RelayMux.Client.COMPUTER, frame, null);
            });
        }

        @Override
        public void onNotificationSent(BluetoothDevice device, int status) {
            main.post(MeshRelay.this::sendNext);
        }
    };

    private void respond(BluetoothDevice device, int requestId, int status, int offset, byte[] value) {
        BluetoothGattServer server = this.server;
        if (server != null) server.sendResponse(device, requestId, status, offset, value);
    }

    // The radio's side

    private void attachRadio() {
        if (!isOn() || radio != null || !poweredOn()) return;
        BluetoothDevice device;
        try {
            device = manager().getAdapter().getRemoteDevice(radioAddress);
        } catch (IllegalArgumentException e) {
            Log.w(TAG, radioAddress + " is not a Bluetooth address");
            return;
        }
        radioRx = null;
        radioWrites.clear();
        radioWriting = false;
        // Joins the link the plugin already has; with autoConnect, waits for a radio out of range.
        radio = device.connectGatt(context, true, radioCallback, BluetoothDevice.TRANSPORT_LE);
    }

    private void releaseRadio() {
        mux.radioDown();
        radioRx = null;
        radioWrites.clear();
        radioWriting = false;
        if (radio == null) return;
        radio.disconnect();
        radio.close();
        radio = null;
    }

    /** Only called while the radio is up: the mux holds commands until then. */
    private void writeRadio(byte[] frame) {
        if (radio == null || radioRx == null) {
            Log.w(TAG, "a frame for the radio with no radio");
            return;
        }
        radioWrites.add(frame);
        if (!radioWriting) writeNext();
    }

    @SuppressWarnings("deprecation") // setValue and the one-argument write are what Android before 13 has.
    private void writeNext() {
        byte[] frame = radioWrites.poll();
        if (frame == null || radio == null || radioRx == null) {
            radioWriting = false;
            return;
        }
        // With response, as the page writes: the characteristic demands encryption.
        boolean started;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            started = radio.writeCharacteristic(radioRx, frame, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == BluetoothStatusCodes.SUCCESS;
        } else {
            radioRx.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
            radioRx.setValue(frame);
            started = radio.writeCharacteristic(radioRx);
        }
        radioWriting = true;
        if (started) {
            writeTries = 0;
        } else if (++writeTries < TRIES) {
            // Another operation on the link is still going; tried again shortly.
            radioWrites.addFirst(frame);
            main.postDelayed(this::writeNext, 20);
        } else {
            Log.w(TAG, "a frame for the radio was dropped");
            writeTries = 0;
            main.post(this::writeNext);
        }
    }

    @SuppressWarnings("deprecation")
    private void subscribeRadio(BluetoothGatt gatt, BluetoothGattCharacteristic tx) {
        gatt.setCharacteristicNotification(tx, true);
        BluetoothGattDescriptor cccd = tx.getDescriptor(CCCD);
        if (cccd == null) {
            // Nothing to write: notifications flow as they are.
            radioReady(gatt);
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            gatt.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
        } else {
            cccd.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
            gatt.writeDescriptor(cccd);
        }
    }

    /** The radio is up once its TX notifies here: then the waiting commands go. */
    private void radioReady(BluetoothGatt gatt) {
        if (gatt != radio || radioRx == null) return;
        mux.radioUp();
    }

    private final BluetoothGattCallback radioCallback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
            main.post(() -> {
                if (gatt != radio) return;
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    // The plugin asked for the same on this link; asked again for a link this made itself.
                    if (gatt.requestMtu(512)) {
                        main.postDelayed(mtuTimeout, 2000);
                    } else {
                        gatt.discoverServices();
                    }
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    main.removeCallbacks(rediscover);
                    discoveries = 0;
                    radioRx = null;
                    radioWrites.clear();
                    radioWriting = false;
                    mux.radioDown();
                    // An autoConnect client reconnects by itself when the radio is back.
                }
            });
        }

        @Override
        public void onMtuChanged(BluetoothGatt gatt, int mtu, int status) {
            main.post(() -> {
                if (gatt != radio || radioRx != null) return;
                main.removeCallbacks(mtuTimeout);
                gatt.discoverServices();
            });
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt gatt, int status) {
            main.post(() -> {
                if (gatt != radio) return;
                BluetoothGattService service = gatt.getService(SERVICE);
                if (status != BluetoothGatt.GATT_SUCCESS || service == null) {
                    // Right after the link comes up, Android can answer from a discovery still under way.
                    Log.w(TAG, "the radio's UART service was not found: " + status);
                    if (++discoveries < 5) main.postDelayed(rediscover, 1000);
                    return;
                }
                discoveries = 0;
                radioRx = service.getCharacteristic(RX);
                BluetoothGattCharacteristic tx = service.getCharacteristic(TX);
                if (radioRx == null || tx == null) {
                    Log.w(TAG, "the radio's UART service is missing RX or TX");
                    return;
                }
                subscribeRadio(gatt, tx);
            });
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt gatt, BluetoothGattDescriptor descriptor, int status) {
            main.post(() -> {
                if (!CCCD.equals(descriptor.getUuid())) return;
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    Log.w(TAG, "the radio's TX did not subscribe: " + status);
                    return;
                }
                radioReady(gatt);
            });
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, int status) {
            main.post(() -> {
                if (gatt != radio) return;
                if (status != BluetoothGatt.GATT_SUCCESS) Log.w(TAG, "a write to the radio failed: " + status);
                writeNext();
            });
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, byte[] value) {
            received(gatt, characteristic, value);
        }

        @Override
        @SuppressWarnings("deprecation") // Android before 13 calls this one, with the value on the characteristic.
        public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) received(gatt, characteristic, characteristic.getValue());
        }

        private void received(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, byte[] value) {
            if (!TX.equals(characteristic.getUuid()) || value == null || value.length == 0) return;
            byte[] frame = value.clone();
            main.post(() -> {
                if (gatt == radio) mux.fromRadio(frame);
            });
        }
    };

    // Bluetooth turned off and on

    private void watchAdapter() {
        if (watchingAdapter) return;
        watchingAdapter = true;
        IntentFilter filter = new IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED);
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                int state = intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR);
                if (state == BluetoothAdapter.STATE_TURNING_OFF || state == BluetoothAdapter.STATE_OFF) {
                    adapterOff();
                } else if (state == BluetoothAdapter.STATE_ON) {
                    attachRadio();
                    publish();
                }
            }
        };
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            context.registerReceiver(receiver, filter);
        }
    }

    /** A Bluetooth restart takes the published service and both links with it. */
    private void adapterOff() {
        advertising = false;
        if (server != null) server.close();
        server = null;
        served = null;
        published = false;
        dropComputer();
        if (radio != null) radio.close();
        radio = null;
        radioRx = null;
        radioWrites.clear();
        radioWriting = false;
        mux.radioDown();
    }
}
