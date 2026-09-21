import { test } from "node:test";
import assert from "node:assert/strict";
import { ByteWriter, fromHex } from "./protocol/bytes.js";
import { Cmd, Push, Resp, TxtType } from "./protocol/codes.js";
import { groupTextPayload, heardGroupTextPayload } from "./protocol/group.js";
import { channelConversation, contactConversation, MeshSession, splitChannelText, type PersistedState } from "./session.js";
import { BaseTransport } from "./transport.js";
import { TimeoutError, TransportClosedError } from "./client.js";

const SELF = fromHex("a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf");
const BOB = fromHex("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20");

/** A radio with one contact, one channel, and whatever is put in its queue. */
class ScriptedRadio extends BaseTransport {
  readonly kind: "ble" | "serial";
  constructor(kind: "ble" | "serial" = "ble") {
    super();
    this.kind = kind;
  }
  readonly label = "MeshCore-test";
  sent: Uint8Array[] = [];
  queue: Uint8Array[] = [];
  contacts: Uint8Array[] = [contactFrame(BOB, "Bob", 10)];
  time = 1_700_000_000;
  nextAck = 0x11223344;
  binaryTag = 0x55667788;
  /** Whether the radio says a text went out as a flood. */
  sendsFlood = false;

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
        return [new ByteWriter().u8(Resp.Sent).u8(this.sendsFlood ? 1 : 0).u32(this.nextAck).u32(2000).toBytes()];
      case Cmd.ResetPath:
        return [new Uint8Array([Resp.Ok])];
      case Cmd.GetContactByKey: {
        const found = this.contacts.find((c) => c.subarray(1, 33).every((b, i) => b === frame[1 + i]));
        return [found ?? new Uint8Array([Resp.Err, 2])];
      }
      case Cmd.SendChannelTxtMsg:
        return [new Uint8Array([Resp.Ok])];
      case Cmd.SendLogin:
        // The radio names a login by the first four bytes of the node's key.
        return [new ByteWriter().u8(Resp.Sent).u8(0).bytes(frame.subarray(1, 5)).u32(2000).toBytes()];
      case Cmd.SendStatusReq:
        return [new ByteWriter().u8(Resp.Sent).u8(0).u32(0x0a0b0c0d).u32(2000).toBytes()];
      case Cmd.SendBinaryReq:
        return [new ByteWriter().u8(Resp.Sent).u8(1).u32(this.binaryTag).u32(2000).toBytes()];
      case Cmd.Logout:
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

/** `path` is the route the radio holds, one-byte hashes; none when absent. */
function contactFrame(key: Uint8Array, name: string, lastMod: number, type = 1, path?: number[]): Uint8Array {
  const route = new Uint8Array(64);
  route.set(path ?? []);
  return new ByteWriter()
    .u8(Resp.Contact)
    .bytes(key)
    .u8(type)
    .u8(0)
    .u8(path ? path.length : 0xff)
    .bytes(route)
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

test("USB message sync retries a lost reply and keeps the session connected", async () => {
  const radio = new ScriptedRadio("serial");
  radio.queue.push(channelFrame(0, "Alice: after the lost reply"));
  const send = radio.send.bind(radio);
  let attempts = 0;
  radio.send = async (frame) => {
    if (frame[0] === Cmd.SyncNextMessage && ++attempts === 1) throw new TimeoutError("syncNextMessage", 8000);
    await send(frame);
  };
  const session = new MeshSession();
  await session.connect(radio);
  assert.equal(session.getState().status, "ready");
  assert.equal(session.getState().messages.length, 1);
  assert.equal(attempts, 3); // lost reply, message, queue empty
  assert.ok(session.getState().log.some((entry) => entry.text.includes("retrying message sync (1/2)")));
  await session.disconnect();
});

test("persistent USB silence still fails after bounded message sync retries", async () => {
  const radio = new ScriptedRadio("serial");
  const send = radio.send.bind(radio);
  let attempts = 0;
  radio.send = async (frame) => {
    if (frame[0] === Cmd.SyncNextMessage) {
      attempts += 1;
      throw new TimeoutError("syncNextMessage", 8000);
    }
    await send(frame);
  };
  const session = new MeshSession();
  await assert.rejects(session.connect(radio), TimeoutError);
  assert.equal(attempts, 3);
  assert.equal(session.getState().status, "closed");
});

test("a USB transport failure is not retried as a message timeout", async () => {
  const radio = new ScriptedRadio("serial");
  const send = radio.send.bind(radio);
  let attempts = 0;
  radio.send = async (frame) => {
    if (frame[0] === Cmd.SyncNextMessage) {
      attempts += 1;
      throw new TransportClosedError(new Error("cable out"));
    }
    await send(frame);
  };
  const session = new MeshSession();
  await assert.rejects(session.connect(radio), TransportClosedError);
  assert.equal(attempts, 1);
  assert.equal(session.getState().status, "closed");
});

test("disconnect during a USB retry cannot send again or change a new session", async () => {
  const radio = new ScriptedRadio("serial");
  const send = radio.send.bind(radio);
  let attempts = 0;
  radio.send = async (frame) => {
    if (frame[0] === Cmd.SyncNextMessage) {
      attempts += 1;
      throw new TimeoutError("syncNextMessage", 8000);
    }
    await send(frame);
  };
  const session = new MeshSession();
  const retryStarted = new Promise<void>((resolve) => {
    const off = session.subscribe(() => {
      if (session.getState().log.some((entry) => entry.text.includes("retrying message sync"))) {
        off();
        resolve();
      }
    });
  });
  const oldConnect = assert.rejects(session.connect(radio), TimeoutError);
  await retryStarted;
  await session.disconnect();
  await session.connect(new ScriptedRadio());
  await oldConnect;
  assert.equal(attempts, 1);
  assert.equal(session.getState().status, "ready");
  assert.equal(session.getState().error, null);
  await session.disconnect();
});

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

test("history saved with the raw path_len byte is read back as a hop count", async () => {
  const storage = new MemoryStorage();
  const session = new MeshSession({ storage, now: () => 1_700_000_000_000 });
  const radio = new ScriptedRadio();
  radio.queue.push(dmFrame(BOB, "one hop, two-byte hashes"));
  await session.connect(radio);
  await session.disconnect();
  const saved = storage.saved.get(session.getState().self!.key)!;
  saved.messages[0]!.hops = 0x41; // what the client stored before it masked the byte

  const second = new MeshSession({ storage, now: () => 1_700_000_000_000 });
  await second.connect(new ScriptedRadio());
  assert.equal(second.getState().messages[0]?.hops, 1);
});

test("a channel message heard back from repeaters is an echo, one per distinct path", async () => {
  const radio = new ScriptedRadio();
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  await session.connect(radio);
  const state = session.getState();
  const sent = await session.sendText("ch:0", "anyone out there?");
  const payload = await groupTextPayload(fromHex(state.channels[0]!.secret), sent.timestamp, state.self!.name, "anyone out there?");
  // A flood GRP_TXT packet as a repeater sends it on: header 0x15, two-byte hashes in the path.
  const heard = (hashes: string[], body: Uint8Array = payload) =>
    new ByteWriter().u8(Push.LogRxData).i8(8).i8(-90).u8(0x15).u8(0x40 | hashes.length).bytes(fromHex(hashes.join(""))).bytes(body).toBytes();
  radio.push(heard(["7932"]));
  radio.push(heard(["7932"])); // the same relay again
  radio.push(heard(["7932", "ce5b"]));
  radio.push(heard(["dc0a"], payload.map((b, i) => (i === 5 ? b ^ 1 : b)))); // someone else's message
  await tick();
  const message = session.getState().messages.find((m) => m.id === sent.id)!;
  assert.deepEqual(message.echoes, [
    { path: ["7932"], snr: 2 },
    { path: ["7932", "ce5b"], snr: 2 },
  ]);
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

// ---- repeaters, rooms and sensors ----

const HILL = fromHex("c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0");
const HILL_KEY = "c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0";
const ROOM = fromHex("e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff00");
const ROOM_KEY = "e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff00";

function statusBody(tail: Uint8Array): Uint8Array {
  return new ByteWriter()
    .u16(4100)
    .u16(1)
    .u16(0xff92) // noise floor -110
    .u16(0xff9e) // last RSSI -98
    .u32(100)
    .u32(50)
    .u32(60)
    .u32(3600)
    .u32(1)
    .u32(2)
    .u32(3)
    .u32(4)
    .u16(0)
    .u16(0xfff8) // last SNR -2 dB, in quarters
    .u16(5)
    .u16(6)
    .bytes(tail)
    .toBytes();
}

function cliFrame(from: Uint8Array, text: string): Uint8Array {
  return new ByteWriter()
    .u8(Resp.ContactMsgRecvV3)
    .i8(20)
    .u16(0)
    .bytes(from.subarray(0, 6))
    .u8(0)
    .u8(TxtType.CliData)
    .u32(1_700_000_070)
    .string(text)
    .toBytes();
}

async function nodeSession(options: { replyWaitMs?: (estimate: number, extra: number) => number } = {}) {
  const radio = new ScriptedRadio();
  radio.contacts = [contactFrame(HILL, "Hill", 10, 2), contactFrame(ROOM, "Lounge", 11, 3), contactFrame(BOB, "Bob", 12)];
  const session = new MeshSession({ now: () => 1_700_000_000_000, ...options });
  await session.connect(radio);
  return { radio, session };
}

function sentText(frame: Uint8Array): string {
  return new TextDecoder().decode(frame.subarray(13));
}

test("remote requests wait their turn: the second goes out only after the first is answered", async () => {
  const { radio, session } = await nodeSession();
  const login = session.login(HILL_KEY, "secret");
  const status = session.requestStatus(HILL_KEY);
  await tick();
  assert.equal(radio.sent.filter((f) => f[0] === Cmd.SendLogin).length, 1);
  assert.equal(radio.sent.filter((f) => f[0] === Cmd.SendStatusReq).length, 0);
  assert.equal(session.getState().remote.active?.label, "sign in");
  assert.deepEqual(
    session.getState().remote.queued.map((j) => j.label),
    ["status"],
  );

  // Admin: flag 1, the node's clock, permissions 3, firmware level 2.
  radio.push(new ByteWriter().u8(Push.LoginSuccess).u8(1).bytes(HILL.subarray(0, 6)).u32(1_699_999_950).u8(3).u8(2).toBytes());
  const result = await login;
  assert.equal(result.ok, true);
  assert.equal(result.role, 3);
  assert.equal(result.serverTime, 1_699_999_950);
  await tick();
  assert.equal(radio.sent.filter((f) => f[0] === Cmd.SendStatusReq).length, 1);

  const tail = new ByteWriter().u32(90).u32(7).toBytes();
  radio.push(new ByteWriter().u8(Push.StatusResponse).u8(0).bytes(HILL.subarray(0, 6)).bytes(statusBody(tail)).toBytes());
  const answered = await status;
  assert.equal(answered.stats?.noiseFloor, -110);
  assert.equal(answered.stats?.lastSnr, -2);
  assert.equal(answered.stats?.rxAirTimeSecs, 90);
  assert.equal(answered.stats?.posted, null);
  assert.deepEqual(session.getState().statusHistory[HILL_KEY], [{ at: 1_700_000_000_000, batteryMv: 4100, noiseFloor: -110 }]);
  assert.equal(session.getState().remote.active, null);
});

test("a room's status tail is its post counts, not receive air time", async () => {
  const { radio, session } = await nodeSession();
  const status = session.requestStatus(ROOM_KEY);
  await tick();
  const tail = new ByteWriter().u16(184).u16(1203).toBytes();
  radio.push(new ByteWriter().u8(Push.StatusResponse).u8(0).bytes(ROOM.subarray(0, 6)).bytes(statusBody(tail)).toBytes());
  const answered = await status;
  assert.equal(answered.stats?.posted, 184);
  assert.equal(answered.stats?.postPushes, 1203);
  assert.equal(answered.stats?.rxAirTimeSecs, null);
});

test("a refused password resolves as not signed in, and frees the queue", async () => {
  const { radio, session } = await nodeSession();
  const login = session.login(HILL_KEY, "wrong");
  await tick();
  radio.push(new ByteWriter().u8(Push.LoginFail).u8(0).bytes(HILL.subarray(0, 6)).toBytes());
  const result = await login;
  assert.equal(result.ok, false);
  assert.equal(result.role, null);
  assert.equal(session.getState().remote.active, null);
});

test("a node that never answers times the request out and lets the next one go", async () => {
  const { radio, session } = await nodeSession({ replyWaitMs: () => 20 });
  const first = session.requestStatus(HILL_KEY);
  const second = session.requestStatus(HILL_KEY);
  await assert.rejects(first, /no reply/);
  await tick();
  assert.equal(radio.sent.filter((f) => f[0] === Cmd.SendStatusReq).length, 2);
  await assert.rejects(second, /no reply/);
});

test("neighbours come back under the radio's tag, with prefixes, age and SNR", async () => {
  const { radio, session } = await nodeSession();
  const request = session.requestNeighbours(HILL_KEY, { order: 2 });
  await tick();
  const sent = radio.sent.find((f) => f[0] === Cmd.SendBinaryReq)!;
  // After the key: type 6, version 0, count 10, offset 0 (two bytes), order 2, six-byte prefixes.
  assert.deepEqual([...sent.subarray(33, 40)], [6, 0, 10, 0, 0, 2, 6]);
  // A reply under another tag is not this one.
  radio.push(new ByteWriter().u8(Push.BinaryResponse).u8(0).u32(0x99).u16(0).u16(0).toBytes());
  radio.push(
    new ByteWriter()
      .u8(Push.BinaryResponse)
      .u8(0)
      .u32(radio.binaryTag)
      .u16(14)
      .u16(2)
      .bytes(fromHex("aabbccddeeff"))
      .u32(120)
      .i8(29)
      .bytes(fromHex("010203040506"))
      .u32(3600)
      .i8(-34)
      .toBytes(),
  );
  const list = await request;
  assert.equal(list.total, 14);
  assert.deepEqual(list.neighbours, [
    { prefix: "aabbccddeeff", heardSecsAgo: 120, snr: 7.25 },
    { prefix: "010203040506", heardSecsAgo: 3600, snr: -8.5 },
  ]);
});

test("a console command carries a tag, and its reply goes to the console, not the chat", async () => {
  const { radio, session } = await nodeSession();
  const reply = session.readNodeSetting(HILL_KEY, "tx");
  await tick();
  const sent = radio.sent.find((f) => f[0] === Cmd.SendTxtMsg)!;
  assert.equal(sent[1], TxtType.CliData);
  const text = sentText(sent);
  assert.match(text, /^[0-9a-f]{2}\|get tx$/);
  radio.queue.push(cliFrame(HILL, `${text.slice(0, 2)}|> 22`));
  radio.push(new Uint8Array([Push.MsgWaiting]));
  assert.equal(await reply, "22");
  const state = session.getState();
  assert.equal(state.messages.length, 0);
  assert.equal(state.nodeSettings[HILL_KEY]?.["tx"]?.value, "22");
  assert.deepEqual(
    state.consoles[HILL_KEY]?.map((e) => [e.command, e.status, e.reply]),
    [["get tx", "done", "> 22"]],
  );
});

test("a console reply that comes after the wait ran out still lands on its command", async () => {
  const { radio, session } = await nodeSession({ replyWaitMs: () => 20 });
  await assert.rejects(session.runCli(HILL_KEY, "ver"), /no reply/);
  const tag = sentText(radio.sent.find((f) => f[0] === Cmd.SendTxtMsg)!).slice(0, 2);
  assert.equal(session.getState().consoles[HILL_KEY]?.[0]?.status, "timeout");
  radio.queue.push(cliFrame(HILL, `${tag}|v1.17.1 (Build: 12-Sep-2026)`));
  radio.push(new Uint8Array([Push.MsgWaiting]));
  await tick(5);
  const entry = session.getState().consoles[HILL_KEY]?.[0];
  assert.equal(entry?.status, "done");
  assert.equal(entry?.reply, "v1.17.1 (Build: 12-Sep-2026)");
});

test("a password change shows in the console without the password", async () => {
  const { radio, session } = await nodeSession();
  const change = session.writeNodeSetting(HILL_KEY, "password", "hunter22", "password hunter22", { mask: "password ••••••" });
  await tick();
  const tag = sentText(radio.sent.find((f) => f[0] === Cmd.SendTxtMsg)!).slice(0, 2);
  radio.queue.push(cliFrame(HILL, `${tag}|password now: hunter22`));
  radio.push(new Uint8Array([Push.MsgWaiting]));
  await change;
  const entry = session.getState().consoles[HILL_KEY]![0]!;
  assert.equal(entry.command, "password ••••••");
  assert.equal(entry.reply, "password now: ••••••");
});

test("a room post is filed under the room and named after its author", async () => {
  const { radio, session } = await nodeSession();
  radio.queue.push(
    new ByteWriter()
      .u8(Resp.ContactMsgRecvV3)
      .i8(8)
      .u16(0)
      .bytes(ROOM.subarray(0, 6))
      .u8(1)
      .u8(TxtType.SignedPlain)
      .u32(1_700_000_010)
      .bytes(BOB.subarray(0, 4))
      .string("posted in the room")
      .toBytes(),
  );
  radio.push(new Uint8Array([Push.MsgWaiting]));
  await tick(5);
  const message = session.getState().messages[0]!;
  assert.equal(message.conversation, contactConversation(ROOM_KEY));
  assert.equal(message.sender, "Bob");
  assert.equal(message.text, "posted in the room");
});

test("the role from a sign-in survives a reconnect", async () => {
  const storage = new MemoryStorage();
  const radio = new ScriptedRadio();
  radio.contacts = [contactFrame(HILL, "Hill", 10, 2)];
  const session = new MeshSession({ storage, now: () => 1_700_000_000_000 });
  await session.connect(radio);
  const login = session.login(HILL_KEY, "secret");
  await tick();
  radio.push(new ByteWriter().u8(Push.LoginSuccess).u8(1).bytes(HILL.subarray(0, 6)).u32(1).u8(3).u8(2).toBytes());
  await login;
  await session.disconnect();

  const again = new ScriptedRadio();
  again.contacts = [contactFrame(HILL, "Hill", 10, 2)];
  const second = new MeshSession({ storage, now: () => 1_700_000_000_000 });
  await second.connect(again);
  assert.equal(second.getState().logins[HILL_KEY]?.role, 3);
});

// ---- routes ----

/** A flooded packet as the radio hands it up on LOG_RX_DATA: header, path_len, one-byte hashes, payload. */
function heardPacket(payloadType: number, hashes: number[], payload: Uint8Array, snr = 8): Uint8Array {
  return new ByteWriter()
    .u8(Push.LogRxData)
    .i8(snr)
    .i8(-90)
    .u8((payloadType << 2) | 1)
    .u8(hashes.length)
    .bytes(new Uint8Array(hashes))
    .bytes(payload)
    .toBytes();
}

test("pinning a contact to flood drops its route now, and again whenever the radio learns one", async () => {
  const radio = new ScriptedRadio();
  radio.contacts = [contactFrame(BOB, "Bob", 1_699_999_000, 1, [0xa3, 0x7f])];
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  await session.connect(radio);
  assert.equal(session.getState().contacts[bobKey()]?.outPathLen, 2);

  await session.setFloodPinned(bobKey(), true);
  assert.equal(radio.sent.filter((f) => f[0] === Cmd.ResetPath).length, 1);
  assert.equal(session.getState().contacts[bobKey()]?.outPathLen, 0xff);
  assert.deepEqual(session.getState().routing.contacts[bobKey()], { flood: true });

  radio.push(new ByteWriter().u8(Push.PathUpdated).bytes(BOB).toBytes());
  await tick(5);
  assert.equal(radio.sent.filter((f) => f[0] === Cmd.ResetPath).length, 2);
  assert.equal(session.getState().contacts[bobKey()]?.outPathLen, 0xff);

  await session.setFloodPinned(bobKey(), false);
  assert.deepEqual(session.getState().routing.contacts, {});
  await session.disconnect();
});

test("a route older than its time limit is dropped before the next message goes", async () => {
  let clock = 1_700_000_000_000;
  const radio = new ScriptedRadio();
  // The radio learned the route a minute ago, while nobody was listening.
  radio.contacts = [contactFrame(BOB, "Bob", 1_699_999_940, 1, [0x7f])];
  const session = new MeshSession({ now: () => clock });
  await session.connect(radio);
  assert.equal(session.getState().contacts[bobKey()]?.pathSince, 1_699_999_940_000);

  session.setDefaultRouteReset(15);
  await tick(5);
  assert.equal(radio.sent.filter((f) => f[0] === Cmd.ResetPath).length, 0);
  assert.equal(session.routeExpiresAt(bobKey()), 1_699_999_940_000 + 15 * 60_000);

  clock += 20 * 60_000;
  await session.sendText(contactConversation(bobKey()), "still there?");
  const codes = radio.sent.map((f) => f[0]);
  const reset = codes.lastIndexOf(Cmd.ResetPath);
  assert.ok(reset >= 0 && reset < codes.lastIndexOf(Cmd.SendTxtMsg), "the route goes before the message");
  assert.equal(session.getState().contacts[bobKey()]?.pathSince, null);

  // A contact of its own that never drops its route is left alone.
  session.setRouteReset(bobKey(), null);
  assert.equal(session.routePolicy(bobKey()).resetAfterMin, null);
  await session.disconnect();
});

test("a direct message that went unacknowledged along a route is retried as a flood", async () => {
  const storage = new MemoryStorage();
  const first = new MeshSession({ storage, now: () => 1_700_000_000_000 });
  const routed = () => {
    const radio = new ScriptedRadio();
    radio.contacts = [contactFrame(BOB, "Bob", 1_699_999_990, 1, [0x7f])];
    return radio;
  };
  await first.connect(routed());
  const sent = await first.sendText(contactConversation(bobKey()), "hello?");
  assert.equal(sent.flood, false);
  assert.deepEqual(sent.route, ["7f"]);
  await first.disconnect();
  // What the ack timer would have done.
  const saved = storage.saved.get(first.getState().self!.key)!;
  saved.messages[0]!.status = "unconfirmed";

  const radio = routed();
  const session = new MeshSession({ storage, now: () => 1_700_000_000_000 });
  await session.connect(radio);
  const message = session.getState().messages[0]!;
  assert.equal(session.retryFloods(message), true);
  await session.retry(message.id);
  const codes = radio.sent.map((f) => f[0]);
  assert.ok(codes.indexOf(Cmd.ResetPath) >= 0 && codes.indexOf(Cmd.ResetPath) < codes.indexOf(Cmd.SendTxtMsg));
  assert.equal(session.getState().messages[0]?.attempt, 1);
  await session.disconnect();
});

test("a flood's acknowledgement brings back the route it took", async () => {
  const radio = new ScriptedRadio();
  radio.sendsFlood = true;
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  await session.connect(radio);
  const sent = await session.sendText(contactConversation(bobKey()), "anyone?");
  assert.equal(sent.flood, true);
  assert.equal(sent.route, null);
  // The path return: the radio learns the route, then matches the ack inside it.
  radio.contacts = [contactFrame(BOB, "Bob", 1_700_000_000, 1, [0xe0, 0x7f])];
  radio.push(new ByteWriter().u8(Push.PathUpdated).bytes(BOB).toBytes());
  radio.push(new ByteWriter().u8(Push.SendConfirmed).u32(0x11223344).u32(4800).toBytes());
  await tick(5);
  const message = session.getState().messages.find((m) => m.id === sent.id)!;
  assert.equal(message.status, "delivered");
  assert.deepEqual(message.route, ["e0", "7f"]);
  assert.equal(session.getState().contacts[bobKey()]?.pathSince, 1_700_000_000_000);
  await session.disconnect();
});

test("an incoming channel message gathers every copy the radio heard, before it and after", async () => {
  const radio = new ScriptedRadio();
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  await session.connect(radio);
  const secret = fromHex(session.getState().channels[0]!.secret);
  const payload = await heardGroupTextPayload(secret, 1_700_000_060, TxtType.Plain, "Alice: who hears me?");
  radio.push(heardPacket(5, [0x7f, 0xa3], payload, 12));
  radio.push(heardPacket(5, [0x9d], payload.map((b, i) => (i === 3 ? b ^ 1 : b)))); // somebody else's
  radio.queue.push(channelFrame(0, "Alice: who hears me?"));
  radio.push(new Uint8Array([Push.MsgWaiting]));
  await tick(10);
  radio.push(heardPacket(5, [0x9d], payload, -20));
  radio.push(heardPacket(5, [0x7f, 0xa3], payload)); // the same path again
  await tick(5);
  const message = session.getState().messages.find((m) => m.direction === "in")!;
  assert.equal(message.sender, "Alice");
  assert.deepEqual(message.echoes, [
    { path: ["7f", "a3"], snr: 3 },
    { path: ["9d"], snr: -5 },
  ]);
  await session.disconnect();
});

test("an incoming flooded direct message takes the packet addressed from its sender to us", async () => {
  const radio = new ScriptedRadio();
  const session = new MeshSession({ now: () => 1_700_000_000_000 });
  await session.connect(radio);
  const sealed = (to: number, from: number) => new Uint8Array([to, from, 0x12, 0x34, ...new Uint8Array(16).fill(from)]);
  radio.push(heardPacket(2, [0x44], sealed(0xa0, 0x99))); // from somebody else
  radio.push(heardPacket(2, [0x7f], sealed(0xa0, 0x01)));
  radio.push(heardPacket(2, [0x55], sealed(0xb0, 0x01))); // to somebody else
  radio.queue.push(dmFrame(BOB, "one hop away"));
  radio.push(new Uint8Array([Push.MsgWaiting]));
  await tick(5);
  radio.push(heardPacket(2, [0x4b], sealed(0xa0, 0x01), -12));
  await tick(5);
  const message = session.getState().messages[0]!;
  assert.equal(message.hops, 1);
  assert.deepEqual(message.echoes, [
    { path: ["7f"], snr: 2 },
    { path: ["4b"], snr: -3 },
  ]);
  await session.disconnect();
});

test("the routing settings survive a reconnect", async () => {
  const storage = new MemoryStorage();
  const session = new MeshSession({ storage, now: () => 1_700_000_000_000 });
  await session.connect(new ScriptedRadio());
  session.setDefaultRouteReset(30);
  session.setRouteReset(bobKey(), 5);
  await session.disconnect();

  const second = new MeshSession({ storage, now: () => 1_700_000_000_000 });
  await second.connect(new ScriptedRadio());
  assert.deepEqual(second.getState().routing, { resetAfterMin: 30, contacts: { [bobKey()]: { resetAfterMin: 5 } } });
  await second.disconnect();
});
