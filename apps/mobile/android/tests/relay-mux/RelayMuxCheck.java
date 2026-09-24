package dev.cm4ker.meshnet;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;

/**
 * Checks for {@code RelayMux}, run with a plain JDK by {@code tests/run.sh}: the mux is compiled
 * with this file, no Gradle and no radio. The same checks as the iOS app's
 * {@code ios/tests/relay-mux/main.swift}.
 */
public final class RelayMuxCheck {
    private static int failures = 0;

    private static void check(boolean condition, String what) {
        if (!condition) {
            failures++;
            System.out.println("FAIL: " + what);
        }
    }

    private static byte[] bytes(int... values) {
        byte[] out = new byte[values.length];
        for (int i = 0; i < values.length; i++) out[i] = (byte) values[i];
        return out;
    }

    private static byte[] join(byte[]... parts) {
        int length = 0;
        for (byte[] part : parts) length += part.length;
        byte[] out = new byte[length];
        int at = 0;
        for (byte[] part : parts) {
            System.arraycopy(part, 0, out, at, part.length);
            at += part.length;
        }
        return out;
    }

    /** Frame lists compared by content. */
    private static boolean same(List<byte[]> got, byte[]... want) {
        if (got.size() != want.length) return false;
        for (int i = 0; i < want.length; i++) {
            if (!Arrays.equals(got.get(i), want[i])) return false;
        }
        return true;
    }

    private static final RelayMux.Client PAGE = RelayMux.Client.PAGE;
    private static final RelayMux.Client COMPUTER = RelayMux.Client.COMPUTER;

    /** A mux wired to lists, with timers run by hand. */
    private static final class Rig {
        final RelayMux mux;
        List<byte[]> radio = new ArrayList<>();
        Map<RelayMux.Client, List<byte[]>> got = new EnumMap<>(RelayMux.Client.class);
        List<Runnable> timers = new ArrayList<>();

        Rig() {
            this(new EnumMap<>(RelayMux.Client.class));
        }

        Rig(Map<RelayMux.Client, List<byte[]>> inboxes) {
            mux = new RelayMux(inboxes);
            clear();
            mux.toRadio = (frame) -> radio.add(frame);
            mux.toClient = (client, frame) -> got.get(client).add(frame);
            mux.timers = (millis, block) -> timers.add(block);
        }

        List<byte[]> got(RelayMux.Client client) {
            return got.get(client);
        }

        /** Fires every timer set so far. */
        void timeout() {
            List<Runnable> due = timers;
            timers = new ArrayList<>();
            for (Runnable block : due) block.run();
        }

        void clear() {
            radio = new ArrayList<>();
            got.put(PAGE, new ArrayList<>());
            got.put(COMPUTER, new ArrayList<>());
        }
    }

    public static void main(String[] args) {
        byte[] sync = bytes(10);
        byte[] noMore = bytes(10);
        byte[] ok = bytes(0);
        byte[] message = bytes(16, 1, 2, 3);

        // Up with an empty queue: the relay reads it once and forwards nothing.
        {
            Rig rig = new Rig();
            rig.mux.attach(PAGE);
            rig.mux.radioUp();
            check(same(rig.radio, sync), "reads the radio's queue on start");
            rig.mux.fromRadio(noMore);
            check(rig.got(PAGE).isEmpty(), "the relay's own answer goes to nobody");
        }

        // Commands from both go one at a time, and each answer to its sender.
        {
            Rig rig = new Rig();
            rig.mux.attach(PAGE);
            rig.mux.attach(COMPUTER);
            rig.mux.radioUp();
            rig.mux.fromRadio(noMore);
            rig.clear();
            rig.mux.fromClient(PAGE, bytes(22, 3), null);
            rig.mux.fromClient(COMPUTER, bytes(5), null);
            check(same(rig.radio, bytes(22, 3)), "only the first command goes out");
            rig.mux.fromRadio(bytes(13, 9));
            check(same(rig.got(PAGE), bytes(13, 9)), "the answer goes to the page");
            check(rig.got(COMPUTER).isEmpty(), "not to the computer");
            check(same(rig.radio, bytes(22, 3), bytes(5)), "then the computer's command goes out");
            rig.mux.fromRadio(bytes(9, 1, 2, 3, 4));
            check(same(rig.got(COMPUTER), bytes(9, 1, 2, 3, 4)), "its answer goes to the computer");
        }

        // The contact list is a stream: the next command waits for its end.
        {
            Rig rig = new Rig();
            rig.mux.attach(PAGE);
            rig.mux.attach(COMPUTER);
            rig.mux.radioUp();
            rig.mux.fromRadio(noMore);
            rig.clear();
            rig.mux.fromClient(COMPUTER, bytes(4), null);
            rig.mux.fromClient(PAGE, bytes(20), null);
            rig.mux.fromRadio(bytes(2, 2, 0, 0, 0));
            rig.mux.fromRadio(bytes(3, 0xaa));
            check(same(rig.radio, bytes(4)), "waits while contacts arrive");
            rig.mux.fromRadio(bytes(3, 0xbb));
            rig.mux.fromRadio(bytes(4, 0, 0, 0, 0));
            check(rig.got(COMPUTER).size() == 4, "the computer gets the whole stream");
            check(same(rig.radio, bytes(4), bytes(20)), "the page's command goes after the end");
        }

        // An error ends a stream too.
        {
            Rig rig = new Rig();
            rig.mux.attach(COMPUTER);
            rig.mux.radioUp();
            rig.mux.fromRadio(noMore);
            rig.clear();
            rig.mux.fromClient(COMPUTER, bytes(4), null);
            rig.mux.fromClient(COMPUTER, bytes(5), null);
            rig.mux.fromRadio(bytes(1, 2));
            check(same(rig.radio, bytes(4), bytes(5)), "an error is a whole answer");
        }

        // Pushes go to both; the radio's own "message waiting" goes to neither.
        {
            Rig rig = new Rig();
            rig.mux.attach(PAGE);
            rig.mux.attach(COMPUTER);
            rig.mux.radioUp();
            rig.mux.fromRadio(noMore);
            rig.clear();
            rig.mux.fromRadio(bytes(0x82, 1, 2, 3, 4));
            check(same(rig.got(PAGE), bytes(0x82, 1, 2, 3, 4)) && same(rig.got(COMPUTER), bytes(0x82, 1, 2, 3, 4)), "a push reaches both");
            rig.mux.fromRadio(bytes(0x83));
            check(same(rig.radio, sync), "message waiting makes the relay read the queue");
            check(rig.got(PAGE).stream().noneMatch((f) -> Arrays.equals(f, bytes(0x83))), "and is not passed on as it is");
        }

        // A message read by the relay lands in both inboxes; each reads its own copy.
        {
            Rig rig = new Rig();
            rig.mux.attach(PAGE);
            rig.mux.attach(COMPUTER);
            rig.mux.radioUp();
            rig.mux.fromRadio(message);
            check(same(rig.got(PAGE), bytes(0x83)) && same(rig.got(COMPUTER), bytes(0x83)), "both are told a message waits");
            check(same(rig.radio, sync, sync), "the relay reads on");
            rig.mux.fromRadio(noMore);
            rig.clear();
            rig.mux.fromClient(PAGE, sync, null);
            check(same(rig.got(PAGE), message), "the page reads its copy");
            rig.mux.fromClient(PAGE, sync, null);
            check(same(rig.got(PAGE), message, noMore), "then nothing more");
            rig.mux.fromClient(COMPUTER, sync, null);
            check(same(rig.got(COMPUTER), message), "the computer still has its copy");
            check(rig.radio.isEmpty(), "none of that asks the radio");
        }

        // A computer away keeps its copies; told of them when it comes back.
        {
            Rig rig = new Rig();
            rig.mux.attach(PAGE);
            rig.mux.radioUp();
            rig.mux.fromRadio(message);
            rig.mux.fromRadio(noMore);
            check(rig.got(COMPUTER).isEmpty(), "an absent computer is told nothing");
            rig.mux.attach(COMPUTER);
            check(same(rig.got(COMPUTER), bytes(0x83)), "and is told when it attaches");
            Rig saved = new Rig(rig.mux.inboxes());
            saved.mux.attach(COMPUTER);
            check(same(saved.got(COMPUTER), bytes(0x83)), "the inboxes survive a restart");
        }

        // A "message waiting" during a read makes one more pass after it.
        {
            Rig rig = new Rig();
            rig.mux.radioUp();
            rig.mux.fromRadio(bytes(0x83));
            rig.mux.fromRadio(noMore);
            check(same(rig.radio, sync, sync), "reads again after a push mid-read");
            rig.mux.fromRadio(noMore);
            check(rig.radio.size() == 2, "and then stops");
        }

        // A command the radio never answers is given up on, and the queue moves.
        {
            Rig rig = new Rig();
            rig.mux.attach(PAGE);
            rig.mux.radioUp();
            rig.mux.fromRadio(noMore);
            rig.clear();
            rig.timers.clear();
            rig.mux.fromClient(PAGE, bytes(19), null);
            rig.mux.fromClient(PAGE, bytes(5), null);
            check(RelayMux.patience(bytes(19)).millis < 2000, "a reboot is not waited on long");
            rig.timeout();
            check(same(rig.radio, bytes(19), bytes(5)), "the next command goes after the timeout");
            rig.mux.fromRadio(bytes(9, 0, 0, 0, 0));
            check(same(rig.got(PAGE), bytes(9, 0, 0, 0, 0)), "and gets its answer");
        }

        // A stale timer does nothing to the next command.
        {
            Rig rig = new Rig();
            rig.mux.attach(PAGE);
            rig.mux.radioUp();
            rig.mux.fromRadio(noMore);
            rig.timers.clear();
            rig.clear();
            rig.mux.fromClient(PAGE, bytes(5), null);
            rig.mux.fromRadio(bytes(9, 0, 0, 0, 0));
            rig.mux.fromClient(PAGE, bytes(20), null);
            rig.mux.fromClient(PAGE, bytes(22), null);
            rig.timers.remove(0).run();
            check(same(rig.radio, bytes(5), bytes(20)), "the old command's timer leaves the new one waiting");
        }

        // Commands wait while the radio is down; one in flight is dropped with it.
        {
            Rig rig = new Rig();
            rig.mux.attach(COMPUTER);
            boolean[] sent = {false};
            rig.mux.fromClient(COMPUTER, bytes(5), () -> sent[0] = true);
            check(rig.radio.isEmpty() && !sent[0], "nothing goes before the radio is up");
            rig.mux.radioUp();
            check(same(rig.radio, bytes(5)) && sent[0], "the command goes once it is up, and its sender hears it went");
            rig.mux.fromRadio(bytes(9, 0, 0, 0, 0));
            check(same(rig.radio, bytes(5), sync), "then the relay reads the queue");
            rig.mux.fromRadio(noMore);
            rig.mux.fromClient(COMPUTER, bytes(20), null);
            rig.clear();
            rig.mux.radioDown();
            rig.mux.fromRadio(bytes(9, 0, 0, 0, 0));
            check(rig.got(COMPUTER).isEmpty(), "an answer after the drop belongs to nothing");
        }

        // A detached client's waiting commands are dropped.
        {
            Rig rig = new Rig();
            rig.mux.attach(PAGE);
            rig.mux.attach(COMPUTER);
            rig.mux.radioUp();
            rig.mux.fromRadio(noMore);
            rig.clear();
            rig.mux.fromClient(PAGE, bytes(5), null);
            rig.mux.fromClient(COMPUTER, bytes(20), null);
            rig.mux.fromClient(PAGE, bytes(22), null);
            rig.mux.detach(COMPUTER);
            rig.mux.fromRadio(bytes(9, 0, 0, 0, 0));
            check(same(rig.radio, bytes(5), bytes(22)), "the computer's command never goes");
        }

        // A text one sends is told to the other, with the radio's answer.
        {
            Rig rig = new Rig();
            rig.mux.attach(PAGE);
            rig.mux.attach(COMPUTER);
            rig.mux.radioUp();
            rig.mux.fromRadio(noMore);
            rig.clear();
            byte[] dm = bytes(2, 0, 0, 1, 2, 3, 4, 9, 9, 9, 9, 9, 9, 104, 105);
            byte[] sent = bytes(6, 0, 7, 7, 7, 7, 0xd0, 7, 0, 0);
            rig.mux.fromClient(PAGE, dm, null);
            rig.mux.fromRadio(sent);
            check(same(rig.got(PAGE), sent), "the sender gets the answer");
            check(same(rig.got(COMPUTER), join(bytes(0xF0, dm.length), dm, sent)), "the other gets the command and the answer");
            rig.clear();
            byte[] channel = bytes(3, 0, 1, 1, 2, 3, 4, 104, 105);
            rig.mux.fromClient(COMPUTER, channel, null);
            rig.mux.fromRadio(ok);
            check(!rig.got(PAGE).isEmpty() && (rig.got(PAGE).get(0)[0] & 0xFF) == 0xF0, "a channel text too, on OK");
            rig.clear();
            rig.mux.fromClient(COMPUTER, channel, null);
            rig.mux.fromRadio(bytes(1, 2));
            check(rig.got(PAGE).isEmpty(), "not one the radio refused");
            rig.mux.fromClient(COMPUTER, bytes(5), null);
            rig.mux.fromRadio(bytes(9, 0, 0, 0, 0));
            check(rig.got(PAGE).isEmpty(), "nor any other command");
        }

        // One for a client that is away waits, and goes ahead of its next message.
        {
            Rig rig = new Rig();
            rig.mux.attach(PAGE);
            rig.mux.radioUp();
            rig.mux.fromRadio(noMore);
            rig.mux.fromClient(PAGE, bytes(3, 0, 0, 1, 2, 3, 4, 104), null);
            rig.mux.fromRadio(ok);
            rig.mux.fromRadio(bytes(0x83));
            rig.mux.fromRadio(message);
            rig.mux.fromRadio(noMore);
            rig.mux.attach(COMPUTER);
            check(same(rig.got(COMPUTER), bytes(0x83)), "the computer is told something waits");
            rig.mux.fromClient(COMPUTER, sync, null);
            List<byte[]> got = rig.got(COMPUTER);
            check(got.size() == 3 && (got.get(1)[0] & 0xFF) == 0xF0 && Arrays.equals(got.get(2), message), "the mirror as a push, then the message");
            rig.mux.fromClient(COMPUTER, sync, null);
            check(Arrays.equals(got.get(got.size() - 1), noMore), "then nothing more");
        }

        // Only mirrors waiting: pushed, and the answer is "no more".
        {
            Rig rig = new Rig();
            rig.mux.attach(PAGE);
            rig.mux.radioUp();
            rig.mux.fromRadio(noMore);
            rig.mux.fromClient(PAGE, bytes(3, 0, 0, 1, 2, 3, 4, 104), null);
            rig.mux.fromRadio(ok);
            rig.mux.attach(COMPUTER);
            rig.clear();
            rig.mux.fromClient(COMPUTER, sync, null);
            List<byte[]> got = rig.got(COMPUTER);
            check(got.size() == 2 && (got.get(0)[0] & 0xFF) == 0xF0 && Arrays.equals(got.get(1), noMore), "a mirror, then no more");
        }

        // Self telemetry is answered by a push only.
        check(RelayMux.patience(bytes(39, 0, 0, 0)).silent, "self telemetry expects no answer");
        check(!RelayMux.patience(bytes(39, 0, 0, 0, 1, 2, 3, 4, 5, 6)).silent, "a contact's does");

        if (failures == 0) {
            System.out.println("RelayMux: all checks passed");
        } else {
            System.out.println("RelayMux: " + failures + " failed");
            System.exit(1);
        }
    }
}
