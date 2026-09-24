package dev.cm4ker.meshnet;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.BiConsumer;
import java.util.function.Consumer;

/**
 * One radio, two clients, and the rules that let them share it. The same rules as the iOS
 * app's {@code MeshRelayMux.swift}, which says why each one is there; keep the two alike.
 *
 * <p>The firmware answers one command at a time, in order, and its answers do not say which
 * command they belong to. So commands wait in one queue and go to the radio one at a time;
 * every answer goes to whoever sent the command in flight, and the next command goes when the
 * answer is complete. Pushes (codes 0x80 and up) go to both.
 *
 * <p>The relay reads the radio's message queue itself and keeps a copy of every message for
 * each client in an inbox; a client's "next message" is answered from there. A text the radio
 * took from one client goes to the other as a {@code mirror} push ({@code 0xF0, length,
 * command, answer}), kept in the inbox of a client that is away.
 *
 * <p>No Bluetooth and no Android here: the owner moves the bytes ({@code toRadio},
 * {@code toClient}) and runs the timers ({@code after}), all on one thread, so this can be
 * checked with a plain JDK ({@code tests/run.sh}).
 */
final class RelayMux {
    /** Who talks to the radio through the relay: the page in this app, and a computer connected to the phone. */
    enum Client {
        PAGE("page"),
        COMPUTER("computer");

        final String key;

        Client(String key) {
            this.key = key;
        }
    }

    /** Runs a block after a delay, on the thread that calls the mux. */
    interface Timers {
        void after(long millis, Runnable block);
    }

    // Command, answer and push codes, as the companion firmware numbers them.
    static final int CMD_SEND_TXT_MSG = 2;
    static final int CMD_SEND_CHANNEL_TXT_MSG = 3;
    static final int CMD_GET_CONTACTS = 4;
    static final int CMD_SYNC_NEXT_MESSAGE = 10;
    static final int CMD_REBOOT = 19;
    static final int CMD_SEND_TELEMETRY_REQ = 39;
    static final int CMD_FACTORY_RESET = 51;
    static final int RESP_OK = 0;
    static final int RESP_ERR = 1;
    static final int RESP_SENT = 6;
    static final int RESP_END_OF_CONTACTS = 4;
    static final int RESP_NO_MORE_MESSAGES = 10;
    static final int PUSH_MSG_WAITING = 0x83;
    /** The app's own, not the firmware's: what the other client sent. */
    static final int PUSH_MIRROR = 0xF0;

    /** Messages kept per client at most; the oldest go first. */
    static final int INBOX_LIMIT = 500;

    Consumer<byte[]> toRadio = (frame) -> {};
    BiConsumer<Client, byte[]> toClient = (client, frame) -> {};
    Timers timers = (millis, block) -> {};
    /** The inboxes changed: the owner saves them. */
    Runnable inboxesChanged = () -> {};
    Consumer<String> log = (line) -> {};

    /** A client's command, or the relay's own reading of the message queue ({@code source} null). */
    private static final class Command {
        final Client source;
        final byte[] frame;
        /** Called once the command is written to the radio. */
        final Runnable dispatched;

        Command(Client source, byte[] frame, Runnable dispatched) {
            this.source = source;
            this.frame = frame;
            this.dispatched = dispatched;
        }

        boolean fromRelay() {
            return source == null;
        }
    }

    private final Set<Client> attached = EnumSet.noneOf(Client.class);
    private final List<Command> queue = new ArrayList<>();
    private Command inFlight;
    /** Bumped per command sent, so a timer for an answered command does nothing. */
    private int flight = 0;
    private boolean radioReady = false;
    private boolean draining = false;
    private boolean drainAgain = false;
    private final Map<Client, List<byte[]>> inboxes = new EnumMap<>(Client.class);

    RelayMux(Map<Client, List<byte[]>> saved) {
        for (Client client : Client.values()) {
            List<byte[]> frames = saved.get(client);
            inboxes.put(client, frames == null ? new ArrayList<>() : new ArrayList<>(frames));
        }
    }

    Map<Client, List<byte[]>> inboxes() {
        return inboxes;
    }

    // Clients

    void attach(Client client) {
        attached.add(client);
        // Messages kept while it was away.
        if (!inboxes.get(client).isEmpty()) toClient.accept(client, bytes(PUSH_MSG_WAITING));
    }

    /** Its waiting commands are dropped; one in flight is still answered, to nobody. */
    void detach(Client client) {
        attached.remove(client);
        List<Command> dropped = new ArrayList<>();
        queue.removeIf((command) -> {
            if (command.source != client) return false;
            dropped.add(command);
            return true;
        });
        for (Command command : dropped) {
            if (command.dispatched != null) command.dispatched.run();
        }
    }

    /**
     * A frame a client wrote. {@code dispatched} is called when it reaches the radio, which for
     * "next message" is at once, from the inbox.
     */
    void fromClient(Client client, byte[] frame, Runnable dispatched) {
        if (frame.length == 0) {
            if (dispatched != null) dispatched.run();
            return;
        }
        if (code(frame) == CMD_SYNC_NEXT_MESSAGE) {
            if (dispatched != null) dispatched.run();
            answerFromInbox(client);
            return;
        }
        queue.add(new Command(client, frame, dispatched));
        pump();
    }

    /** Mirrors kept for it go out as pushes first; then the next message is the answer. */
    private void answerFromInbox(Client client) {
        List<byte[]> inbox = inboxes.get(client);
        byte[] answer = bytes(RESP_NO_MORE_MESSAGES);
        List<byte[]> pushes = new ArrayList<>();
        boolean changed = false;
        while (!inbox.isEmpty()) {
            byte[] frame = inbox.remove(0);
            changed = true;
            if (code(frame) == PUSH_MIRROR) {
                pushes.add(frame);
            } else {
                answer = frame;
                break;
            }
        }
        if (changed) inboxesChanged.run();
        for (byte[] push : pushes) toClient.accept(client, push);
        toClient.accept(client, answer);
    }

    // The radio

    void radioUp() {
        radioReady = true;
        // Whatever arrived while nobody read the queue.
        drain();
        pump();
    }

    /** A command in flight is lost with the link; its sender times out on its own. */
    void radioDown() {
        radioReady = false;
        if (inFlight != null && inFlight.fromRelay()) draining = false;
        inFlight = null;
        flight++;
    }

    void fromRadio(byte[] frame) {
        if (frame.length == 0) return;
        int code = code(frame);
        if (code >= 0x80) {
            if (code == PUSH_MSG_WAITING) {
                drain();
            } else {
                for (Client client : Client.values()) {
                    if (attached.contains(client)) toClient.accept(client, frame);
                }
            }
            return;
        }
        Command command = inFlight;
        if (command == null) return; // late, for a command given up on
        if (command.fromRelay()) {
            if (isMessage(code)) {
                keep(frame);
                queue.add(new Command(null, bytes(CMD_SYNC_NEXT_MESSAGE), null));
            } else {
                draining = false;
                if (drainAgain) {
                    drainAgain = false;
                    drain();
                }
            }
        } else {
            if (attached.contains(command.source)) toClient.accept(command.source, frame);
            mirror(command.frame, frame, command.source);
        }
        if (isComplete(command.frame, code)) {
            finish();
        } else {
            arm(command); // a stream: each frame restarts the wait
        }
    }

    // The queue

    private void drain() {
        if (draining) {
            drainAgain = true;
            return;
        }
        draining = true;
        queue.add(new Command(null, bytes(CMD_SYNC_NEXT_MESSAGE), null));
        pump();
    }

    private void keep(byte[] message) {
        for (Client client : Client.values()) {
            add(message, client);
            if (attached.contains(client)) toClient.accept(client, bytes(PUSH_MSG_WAITING));
        }
        inboxesChanged.run();
    }

    /** A text the radio took from one client, told to the other. */
    private void mirror(byte[] command, byte[] answer, Client sender) {
        boolean taken;
        switch (code(command)) {
            case CMD_SEND_TXT_MSG:
                taken = code(answer) == RESP_SENT;
                break;
            case CMD_SEND_CHANNEL_TXT_MSG:
                taken = code(answer) == RESP_OK;
                break;
            default:
                taken = false;
        }
        if (!taken || command.length >= 256) return;
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(PUSH_MIRROR);
        out.write(command.length);
        out.write(command, 0, command.length);
        out.write(answer, 0, answer.length);
        byte[] frame = out.toByteArray();
        boolean kept = false;
        for (Client client : Client.values()) {
            if (client == sender) continue;
            if (attached.contains(client)) {
                toClient.accept(client, frame);
            } else {
                add(frame, client);
                kept = true;
            }
        }
        if (kept) inboxesChanged.run();
    }

    private void add(byte[] frame, Client client) {
        List<byte[]> inbox = inboxes.get(client);
        inbox.add(frame);
        while (inbox.size() > INBOX_LIMIT) inbox.remove(0);
    }

    private void pump() {
        if (!radioReady || inFlight != null || queue.isEmpty()) return;
        Command command = queue.remove(0);
        inFlight = command;
        toRadio.accept(command.frame);
        if (command.dispatched != null) command.dispatched.run();
        arm(command);
    }

    private void finish() {
        inFlight = null;
        flight++;
        pump();
    }

    private void arm(Command command) {
        flight++;
        int mine = flight;
        Patience patience = patience(command.frame);
        timers.after(patience.millis, () -> {
            if (flight != mine || inFlight == null) return;
            if (command.fromRelay()) draining = false;
            if (!patience.silent) log.accept("command " + code(command.frame) + " got no answer");
            finish();
        });
    }

    /** How long a command may wait for its answer, and whether the radio answers it at all. */
    static final class Patience {
        final long millis;
        final boolean silent;

        Patience(long millis, boolean silent) {
            this.millis = millis;
            this.silent = silent;
        }
    }

    static Patience patience(byte[] frame) {
        switch (frame.length == 0 ? -1 : code(frame)) {
            case CMD_REBOOT:
                return new Patience(1500, true);
            case CMD_FACTORY_RESET:
                return new Patience(3000, true);
            // About this radio (no key after the code and three zeros): only a push answers it.
            case CMD_SEND_TELEMETRY_REQ:
                return frame.length <= 4 ? new Patience(300, true) : new Patience(8000, false);
            case CMD_GET_CONTACTS:
                return new Patience(20000, false);
            default:
                return new Patience(8000, false);
        }
    }

    /**
     * Whether {@code answer} is a command's last frame: an error always is, and so is any single
     * answer; only the contact list comes as a stream.
     */
    static boolean isComplete(byte[] command, int answer) {
        if (answer == RESP_ERR) return true;
        if (code(command) == CMD_GET_CONTACTS) return answer == RESP_END_OF_CONTACTS;
        return true;
    }

    /** The answers that carry a message from the radio's queue. */
    static boolean isMessage(int code) {
        return code == 7 || code == 8 || code == 16 || code == 17 || code == 27;
    }

    private static int code(byte[] frame) {
        return frame[0] & 0xFF;
    }

    private static byte[] bytes(int... values) {
        byte[] out = new byte[values.length];
        for (int i = 0; i < values.length; i++) out[i] = (byte) values[i];
        return out;
    }
}
