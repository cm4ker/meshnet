import { test } from "node:test";
import assert from "node:assert/strict";
import { ByteWriter, fromHex } from "./protocol/bytes.js";
import { Cmd, Push, Resp, TxtType } from "./protocol/codes.js";
import { channelConversation, contactConversation, MeshSession, splitChannelText, type PersistedState } from "./session.js";
import { BaseTransport } from "./transport.js";

const SELF = fromHex("a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf");
const BOB = fromHex("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20");

/** A radio with one contact, one channel, and whatever is put in its queue. */
class ScriptedRadio extends BaseTransport {
  readonly kind = "ble" as const;
  readonly label = "MeshCore-test";
  sent: Uint8Array[] = [];
  queue: Uint8Array[] = [];
  contacts: Uint8Array[] = [contactFrame(BOB, "Bob", 10)];
  time = 1_700_000_000;
  nextAck = 0x11223344;

  async send(frame: Uint8Array): Promise<void> {
    this.sent.push(frame);
    const replies = this.answer(frame);
    queueMicrotask(() => {
      for (const reply of replies) this.emitFrame(reply);
    });
  }

  private answer(frame: Uint8Array): Uint8Array[] {
    switch (frame[0]) {
      case Cmd.DeviceQuery:
        return [
          new ByteWriter()
            .u8(Resp.DeviceInfo)
            .u8(13)
            .u8(50)
            .u8(2)
            .u32(0)
            .fixedString("d", 12)
            .fixedString("m", 40)
            .fixedString("v1.17.1", 20)
            .toBytes(),
        ];
      case Cmd.AppStart:
        return [
          new ByteWriter()
            .u8(Resp.SelfInfo)
            .u8(1)
            .i8(22)
            .i8(22)
            .bytes(SELF)
            .i32(0)
            .i32(0)
            .u8(0)
            .u8(0)
            .u8(0)
            .u8(0)
            .u32(869_161)
            .u32(62_500)
            .u8(7)
            .u8(7)
            .string("Me")
            .toBytes(),
        ];
      case Cmd.GetDeviceTime:
        return [new ByteWriter().u8(Resp.CurrTime).u32(this.time).toBytes()];
      case Cmd.SetDeviceTime:
        return [new Uint8Array([Resp.Ok])];
      case Cmd.GetContacts:
        return [
          new ByteWriter().u8(Resp.ContactsStart).u32(this.contacts.length).toBytes(),
          ...this.contacts,
          new ByteWriter().u8(Resp.EndOfContacts).u32(10).toBytes(),
        ];
      case Cmd.GetChannel: {
        const index = frame[1]!;
        if (index === 0) {
          return [new ByteWriter().u8(Resp.ChannelInfo).u8(0).fixedString("Public", 32).bytes(new Uint8Array(16).fill(1)).toBytes()];
        }
        return [new ByteWriter().u8(Resp.ChannelInfo).u8(index).fixedString("", 32).zeros(16).toBytes()];
      }
      case Cmd.SyncNextMessage: {
        const next = this.queue.shift();
        return [next ?? new Uint8Array([Resp.NoMoreMessages])];
      }
      case Cmd.GetBattAndStorage:
        return [new ByteWriter().u8(Resp.BattAndStorage).u16(4100).u32(1).u32(2).toBytes()];
      case Cmd.SendTxtMsg:
        return [new ByteWriter().u8(Resp.Sent).u8(0).u32(this.nextAck).u32(2000).toBytes()];
      case Cmd.SendChannelTxtMsg:
        return [new Uint8Array([Resp.Ok])];
      default:
        return [new Uint8Array([Resp.Err, 1])];
    }
  }

  push(frame: Uint8Array): void {
    this.emitFrame(frame);
  }

  protected async shutdown(): Promise<void> {}
}

function contactFrame(key: Uint8Array, name: string, lastMod: number): Uint8Array {
  return new ByteWriter()
    .u8(Resp.Contact)
    .bytes(key)
    .u8(1)
    .u8(0)
    .u8(0xff)
    .zeros(64)
    .fixedString(name, 32)
    .u32(0)
    .i32(0)
    .i32(0)
    .u32(lastMod)
    .toBytes();
}

function dmFrame(from: Uint8Array, text: string): Uint8Array {
  return new ByteWriter()
    .u8(Resp.ContactMsgRecvV3)
    .i8(20)
    .u8(0)
    .u8(0)
    .bytes(from.subarray(0, 6))
    .u8(1)
    .u8(TxtType.Plain)
    .u32(1_700_000_050)
    .string(text)
    .toBytes();
}

function channelFrame(index: number, text: string): Uint8Array {
  return new ByteWriter()
    .u8(Resp.ChannelMsgRecvV3)
    .i8(0)
    .u8(0)
    .u8(0)
    .u8(index)
    .u8(0xff)
    .u8(TxtType.Plain)
    .u32(1_700_000_060)
    .string(text)
    .toBytes();
}

class MemoryStorage {
  saved = new Map<string, PersistedState>();
  async load(key: string): Promise<PersistedState | null> {
    return this.saved.get(key) ?? null;
  }
  async save(key: string, state: PersistedState): Promise<void> {
    this.saved.set(key, structuredClone(state));
  }
}

function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("connecting queries the radio, reads its contacts and channels, and drains the queue", async () => {
  const radio = new ScriptedRadio();
  radio.queue.push(dmFrame(BOB, "hello"), channelFrame(0, "Alice: hi all"));
  const session = new MeshSession({ now: () => 1_700_000_100_000 });
  await session.connect(radio);
  const state = session.getState();
  assert.equal(state.status, "ready");
  assert.equal(state.self?.name, "Me");
  assert.equal(state.device?.firmwareVersion, "v1.17.1");
  assert.equal(Object.keys(state.contacts).length, 1);
  assert.equal(state.contacts[bobKey()]?.name, "Bob");
  assert.equal(state.contactsCursor, 10);
  assert.deepEqual(
    state.channels.map((c) => c.name),
    ["Public"],
  );
  assert.equal(state.messages.length, 2);
  const [dm, ch] = state.messages;
  assert.equal(dm?.conversation, contactConversation(bobKey()));
  assert.equal(dm?.sender, "Bob");
  assert.equal(dm?.snr, 5);
  assert.equal(dm?.hops, 1);
  assert.equal(ch?.conversation, channelConversation(0));
  assert.equal(ch?.sender, "Alice");
  assert.equal(ch?.text, "hi all");
  assert.deepEqual(state.unread, { [contactConversation(bobKey())]: 1, [channelConversation(0)]: 1 });
  // The clock was a hundred seconds behind, so it was set.
  assert.ok(radio.sent.some((f) => f[0] === Cmd.SetDeviceTime));
});

test("a message-waiting push drains the queue again, and a focused conversation stays read", async () => {
  const radio = new ScriptedRadio();
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  await session.connect(radio);
  session.focus(contactConversation(bobKey()));
  radio.queue.push(dmFrame(BOB, "again"));
  radio.push(new Uint8Array([Push.MsgWaiting]));
  await tick(5);
  const state = session.getState();
  assert.equal(state.messages.length, 1);
  assert.deepEqual(state.unread, {});
});

test("a direct message is sent, then delivered when its ack arrives", async () => {
  const radio = new ScriptedRadio();
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  await session.connect(radio);
  const sent = await session.sendText(contactConversation(bobKey()), "yo");
  assert.equal(sent.status, "sent");
  assert.equal(sent.ackTag, 0x11223344);
  radio.push(new ByteWriter().u8(Push.SendConfirmed).u32(0x11223344).u32(1500).toBytes());
  await tick();
  const message = session.getState().messages.find((m) => m.id === sent.id);
  assert.equal(message?.status, "delivered");
  assert.equal(message?.roundTripMs, 1500);
  await session.disconnect();
});

test("a channel message goes out with the sender's name accounted for, and is 'sent' on OK", async () => {
  const radio = new ScriptedRadio();
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  await session.connect(radio);
  const message = await session.sendText(channelConversation(0), "hello channel");
  assert.equal(message.status, "sent");
  assert.equal(session.textBudget(channelConversation(0)), 160 - 2 - 2);
  const frame = radio.sent.find((f) => f[0] === Cmd.SendChannelTxtMsg)!;
  assert.equal(frame[2], 0);
});

test("what was heard survives a reconnect through the storage, keyed by the radio", async () => {
  const storage = new MemoryStorage();
  const radio = new ScriptedRadio();
  radio.queue.push(dmFrame(BOB, "remember me"));
  const session = new MeshSession({ storage, now: () => 1_700_000_000_000 });
  await session.connect(radio);
  await session.disconnect();
  assert.equal(session.getState().status, "closed");

  const again = new ScriptedRadio();
  const second = new MeshSession({ storage, now: () => 1_700_000_000_000 });
  await second.connect(again);
  assert.equal(second.getState().messages[0]?.text, "remember me");
  // The contact cursor was kept, so the second fetch asked only for changes.
  const fetch = again.sent.find((f) => f[0] === Cmd.GetContacts)!;
  assert.equal(fetch.length, 5);
});

test("a message from a sender not yet in the contacts is filed under its prefix, then moved", async () => {
  const radio = new ScriptedRadio();
  radio.contacts = [];
  radio.queue.push(dmFrame(BOB, "who am I"));
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  await session.connect(radio);
  assert.equal(session.getState().messages[0]?.conversation, "p:010203040506");
  radio.push(new ByteWriter().u8(Push.NewAdvert).bytes(contactFrame(BOB, "Bob", 11).subarray(1)).toBytes());
  await tick();
  assert.equal(session.getState().messages[0]?.conversation, contactConversation(bobKey()));
  assert.equal(session.getState().messages[0]?.sender, "Bob");
});

test("the sender of a channel message is the name before the colon", () => {
  assert.deepEqual(splitChannelText("Alice: hi: there"), { sender: "Alice", text: "hi: there" });
  assert.deepEqual(splitChannelText("no sender"), { sender: null, text: "no sender" });
});

function bobKey(): string {
  return "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
}
