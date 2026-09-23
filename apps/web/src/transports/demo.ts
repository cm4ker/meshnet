/**
 * A radio that is not there: a scripted one, for looking at the client with
 * no hardware on the desk. Offered when the page is opened with `?demo`, or
 * in development. It has a few contacts and channels, answers every command
 * the session sends, acknowledges messages a moment later, and has somebody
 * say something every so often. It also hands up the packets it "hears", so
 * routes, copies and relays show as they would on a real mesh: a flood learns
 * a route when it is acknowledged, and a route to Bob (on his bike) often
 * turns out to be gone.
 */

import { BaseTransport, ByteWriter, Cmd, fromHex, fromUtf8, groupTextPayload, heardGroupTextPayload, Push, ReqType, Resp, TxtType, type Transport } from "@meshnet/meshcore";
import type { Connector } from "./types.js";

const SELF = fromHex("a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf");

interface Person {
  key: Uint8Array;
  name: string;
  type: number;
  hops: number;
  lat: number;
  lon: number;
  /** Seconds since its last advert; ten minutes when not said. */
  ago?: number;
}

const PEOPLE: Person[] = [
  { key: seeded(1), name: "Alice", type: 1, hops: 0, lat: 55.03, lon: 73.37 },
  { key: seeded(2), name: "Bob (bike)", type: 1, hops: 1, lat: 0, lon: 0 },
  { key: seeded(3), name: "Hill Repeater", type: 2, hops: 1, lat: 55.05, lon: 73.4 },
  { key: seeded(4), name: "Town Room", type: 3, hops: 2, lat: 0, lon: 0 },
  { key: seeded(5), name: "Weather sensor", type: 4, hops: 0xff, lat: 55.01, lon: 73.3 },
  { key: seeded(7), name: "Tower Repeater", type: 2, hops: 1, lat: 55.09, lon: 73.31 },
  // Signs paths with the same first byte as Hill Repeater, as one-byte hashes on a busy mesh do.
  { key: startingWith(0x6f, 6), name: "Ridge Repeater", type: 2, hops: 2, lat: 55.12, lon: 73.5 },
  // A name ending in an emoji, which goes on the node's circle.
  { key: seeded(8), name: "Kolya ⛺", type: 1, hops: 1, lat: 55.075, lon: 73.43, ago: 3 * 86400 },
];

/**
 * `?demo&crowd=400`: that many more nodes scattered round the town, heard
 * from a minute to a few days ago, to see how the map and the lists hold up.
 */
const CROWD = (() => {
  try {
    return Math.min(3000, Math.max(0, Number(new URLSearchParams(globalThis.location?.search ?? "").get("crowd")) || 0));
  } catch {
    return 0;
  }
})();
{
  let seed = 0x2545f491;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  const tails = ["", "", "", "", " 🦊", " 🚲", " 🏔️", " 📡"];
  for (let i = 0; i < CROWD; i++) {
    const key = new Uint8Array(32);
    for (let b = 0; b < 32; b++) key[b] = Math.floor(rand() * 256);
    const roll = rand();
    const type = roll < 0.8 ? 1 : roll < 0.95 ? 2 : 3;
    const name = type === 2 ? `Rpt-${i}` : type === 3 ? `Room ${i}` : `Node-${i}${tails[Math.floor(rand() * tails.length)]}`;
    PEOPLE.push({ key, name, type, hops: 1 + Math.floor(rand() * 3), lat: 55.05 + (rand() - 0.5) * 0.5, lon: 73.4 + (rand() - 0.5) * 0.9, ago: Math.floor(60 + rand() * rand() * 4 * 86400) });
  }
}

/**
 * `?demo&stale=90`: that many more nodes last heard three weeks to four
 * months ago, with no position, to fill the radio's memory and see the
 * clean-up at work.
 */
{
  let stale = 0;
  try {
    stale = Math.min(500, Math.max(0, Number(new URLSearchParams(globalThis.location?.search ?? "").get("stale")) || 0));
  } catch {
    stale = 0;
  }
  const kinds = [1, 1, 1, 2, 2, 3, 4];
  for (let i = 0; i < stale; i++) {
    const key = seeded(1000 + i);
    key[1] = (i * 97) & 0xff;
    const type = kinds[i % kinds.length]!;
    const name = type === 2 ? `Old rpt ${i}` : type === 3 ? `Old room ${i}` : type === 4 ? `Old sensor ${i}` : `Passer-by ${i}`;
    PEOPLE.push({ key, name, type, hops: 0xff, lat: 0, lon: 0, ago: (20 + ((i * 37) % 100)) * 86400 });
  }
}

function seeded(n: number): Uint8Array {
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) key[i] = (n * 37 + i * 11) & 0xff;
  return key;
}

function startingWith(first: number, n: number): Uint8Array {
  const key = seeded(n);
  key[0] = first;
  return key;
}

/** Path hashes the demo's packets travel through: Tower, Town Room, Hill or Ridge (0x6f), and a stranger. */
const RELAYS = [0x03, 0x94, 0x6f, 0x2c];

const CHANNELS = ["8b3387e9c5cdea6ac9e5edbaa115cd72", "0123456789abcdef0123456789abcdef"];

function contactFrame(code: number, p: Person, lastMod: number, hops = p.hops, relays: number[] = RELAYS, flags = p.name === "Alice" ? 1 : 0): Uint8Array {
  const path = new Uint8Array(64);
  if (hops !== 0xff) path.set(relays.slice(0, hops));
  return new ByteWriter()
    .u8(code)
    .bytes(p.key)
    .u8(p.type)
    .u8(flags)
    .u8(hops)
    .bytes(path)
    .fixedString(p.name, 32)
    .u32(Math.floor(Date.now() / 1000) - (p.ago ?? 600))
    .i32(Math.round(p.lat * 1e6))
    .i32(Math.round(p.lon * 1e6))
    .u32(lastMod)
    .toBytes();
}

const LINES = [
  "Anyone up on the hill today?",
  "Repeater's back on solar, looks healthy",
  "Coffee at the usual place, 15:00",
  "Got the sensor node reporting again",
  "SNR to the tower is great from here",
  "Ping me when you're in range",
];

/** What the demo's repeater, room and sensor answer `get` with, and change on `set`. */
function nodePrefs(p: Person): Record<string, string> {
  return {
    name: p.name,
    lat: String(p.lat),
    lon: String(p.lon),
    "owner.info": p.type === 2 ? "Hill club|ask on #test" : "",
    radio: "869.161,62.500,7,7",
    tx: "22",
    repeat: p.type === 2 ? "on" : "off",
    "flood.max": "64",
    "advert.interval": "0",
    "flood.advert.interval": "47",
    txdelay: "0.5",
    "direct.txdelay": "0.3",
    rxdelay: "0.0",
    af: "1.0",
    "guest.password": "guest",
    "allow.read.only": "off",
    powersaving: "off",
  };
}

/**
 * How well each node hears the one before it on a trace, dB, by the hash it
 * signs with: the tower well, the hill fairly, the town room barely, the
 * stranger worse. Below about −8 dB a hop is more often lost than not.
 */
const HEARS: Record<number, number> = { 0x03: 6.5, 0x6f: -3, 0x94: -6.25, 0x2c: -9 };

function heardAt(hash: number): number {
  return Math.round(((HEARS[hash] ?? -4) + (Math.random() * 2 - 1)) * 4) / 4;
}

/** A trace gets through a hop heard at `snr` with this chance. */
function through(snr: number): boolean {
  return Math.random() < 1 / (1 + Math.exp(-(snr + 7.5) / 1.1));
}

/** Repeaters the demo repeater hears direct: prefix, seconds ago, SNR in dB. */
const NEIGHBOURS: [string, number, number][] = [
  ["0a1b2c3d4e5f", 240, 7.25],
  ["e07b55a1c2d3", 120, 9],
  ["40c1d8e3a902", 660, 3.5],
  ["b2d9e4f5a6b7", 2880, 1.25],
  ["7fa013c4d5e6", 1560, -2.75],
  ["5e21b0112233", 3840, -8.5],
  ["18c6aa445566", 7860, -5.5],
  ["c07d44778899", 11220, -12.25],
  ["62e9f0aabbcc", 12720, 0.5],
  ["0d4c7bddeeff", 18300, -14],
  ["9aa3e1102030", 20400, 4.75],
  ["f1b208405060", 28800, -10.25],
];

class DemoRadio extends BaseTransport {
  readonly kind = "ble" as const;
  readonly label = "MeshCore-demo";
  private queue: Uint8Array[] = [];
  private timers: ReturnType<typeof setTimeout>[] = [];
  private chatter: ReturnType<typeof setInterval> | null = null;
  private acks = 0x1000;
  private prefs = new Map<Person, Record<string, string>>(PEOPLE.filter((p) => p.type >= 2).map((p) => [p, nodePrefs(p)]));
  /** Nodes that took our admin password; only they answer the console. */
  private admins = new Set<Person>();
  /** The route this radio holds to each contact, as a hop count; 0xff for none. */
  private routes = new Map<Person, number>(PEOPLE.map((p) => [p, p.hops]));
  /** Contacts taken off this radio, and the flags written to the others. */
  private gone = new Set<Person>();
  private flags = new Map<Person, number>();
  private autoAdd = { config: 0, maxHops: 0 };
  /** Routes written by hand, relay by relay; the rest go along `RELAYS`. */
  private paths = new Map<Person, number[]>();
  /** Texts on Friends whose first send the repeaters already missed. */
  private missed = new Set<string>();
  private murmur: ReturnType<typeof setInterval> | null = null;

  start(): void {
    // Queued before the app connected: their packets were never heard, so their routes are unknown.
    this.queue.push(this.dm(PEOPLE[0]!, "Welcome to the demo mesh 👋"), this.channel(0, "Bob (bike)", "Public channel works too"));
    this.chatter = setInterval(() => void this.chat(), 25_000);
    this.murmur = setInterval(() => this.overhear(), 3_500);
  }

  /** The mesh going about its business: adverts, acks and requests between others, which the radio overhears. */
  private overhear(): void {
    const someone = PEOPLE[Math.floor(Math.random() * PEOPLE.length)]!;
    const pick = Math.random();
    const noise = (n: number) => {
      const bytes = new Uint8Array(n);
      crypto.getRandomValues(bytes);
      return bytes;
    };
    const paths = [[0x03], [0x6f, 0x03], [0x2c, 0x94, 0x03], []];
    const path = paths[Math.floor(Math.random() * paths.length)]!;
    if (pick < 0.3) {
      const advert = noise(110);
      advert.set(someone.key, 0);
      this.emitFrame(this.heard(4, path, advert));
    } else if (pick < 0.55) {
      this.emitFrame(this.heard(3, path, noise(4)));
    } else if (pick < 0.8) {
      const sealed = noise(40);
      sealed[0] = PEOPLE[Math.floor(Math.random() * PEOPLE.length)]!.key[0]!;
      sealed[1] = someone.key[0]!;
      this.emitFrame(this.heard(2, path, sealed));
    } else {
      const request = noise(24);
      request[0] = 0x6f;
      request[1] = someone.key[0]!;
      this.emitFrame(this.heard(0, path, request));
    }
  }

  private async chat(): Promise<void> {
    const who = PEOPLE[Math.floor(Math.random() * 2)]!;
    const line = LINES[Math.floor(Math.random() * LINES.length)]!;
    if (Math.random() < 0.5) await this.heardChannel(0, who.name, line);
    else this.heardDm(who, line);
  }

  /** A channel message from somebody: its first copy, the message, then the copies other repeaters send on. */
  private async heardChannel(index: number, sender: string, text: string): Promise<void> {
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = await heardGroupTextPayload(fromHex(CHANNELS[index]!), timestamp, TxtType.Plain, `${sender}: ${text}`);
    const paths = [[0x03], [0x6f, 0x03], [0x2c, 0x94, 0x03]].sort(() => Math.random() - 0.5).slice(0, 1 + Math.floor(Math.random() * 3));
    this.emitFrame(this.heard(5, paths[0]!, payload));
    this.queue.push(this.channel(index, sender, text, timestamp, paths[0]!.length));
    this.emitFrame(new Uint8Array([Push.MsgWaiting]));
    paths.slice(1).forEach((path, i) => this.later(700 * (i + 1), this.heard(5, path, payload)));
  }

  /** A direct message that flooded here: its packet names us and the sender, and a second copy trails it. */
  private heardDm(from: Person, text: string): void {
    const sealed = new Uint8Array(20);
    crypto.getRandomValues(sealed);
    sealed[0] = SELF[0]!;
    sealed[1] = from.key[0]!;
    const path = RELAYS.slice(0, from.hops);
    this.emitFrame(this.heard(2, path, sealed));
    this.queue.push(this.dm(from, text));
    this.emitFrame(new Uint8Array([Push.MsgWaiting]));
    this.later(900, this.heard(2, [0x6f, ...path], sealed));
  }

  /** A packet the radio heard, as it hands them up on LOG_RX_DATA: flooded, one-byte hashes. */
  private heard(payloadType: number, path: number[], payload: Uint8Array): Uint8Array {
    return new ByteWriter()
      .u8(Push.LogRxData)
      .i8(Math.round((Math.random() * 20 - 8) * 4))
      .i8(-60 - Math.round(Math.random() * 50))
      .u8((payloadType << 2) | 1)
      .u8(path.length)
      .bytes(new Uint8Array(path))
      .bytes(payload)
      .toBytes();
  }

  private dm(from: Person, text: string): Uint8Array {
    return new ByteWriter()
      .u8(Resp.ContactMsgRecvV3)
      .i8(Math.round((Math.random() * 20 - 5) * 4))
      .u8(0)
      .u8(0)
      .bytes(from.key.subarray(0, 6))
      .u8(from.hops === 0xff ? 0xff : from.hops)
      .u8(TxtType.Plain)
      .u32(Math.floor(Date.now() / 1000))
      .string(text)
      .toBytes();
  }

  private channel(index: number, sender: string, text: string, timestamp = Math.floor(Date.now() / 1000), hops = 1): Uint8Array {
    return new ByteWriter()
      .u8(Resp.ChannelMsgRecvV3)
      .i8(Math.round((Math.random() * 20 - 5) * 4))
      .u8(0)
      .u8(0)
      .u8(index)
      .u8(hops)
      .u8(TxtType.Plain)
      .u32(timestamp)
      .string(`${sender}: ${text}`)
      .toBytes();
  }

  private person(key: Uint8Array): Person | undefined {
    return PEOPLE.find((p) => !this.gone.has(p) && key.every((b, i) => b === p.key[i]));
  }

  private sent(tag: number, flood = false): Uint8Array {
    return new ByteWriter().u8(Resp.Sent).u8(flood ? 1 : 0).u32(tag).u32(2500).toBytes();
  }

  /** A console reply: queued as a CliData message and announced, after the node's pause. */
  private cliReply(p: Person, text: string, ms = 1100 + Math.random() * 900): void {
    this.timers.push(
      setTimeout(() => {
        this.queue.push(
          new ByteWriter()
            .u8(Resp.ContactMsgRecvV3)
            .i8(24)
            .u16(0)
            .bytes(p.key.subarray(0, 6))
            .u8(p.hops)
            .u8(TxtType.CliData)
            .u32(Math.floor(Date.now() / 1000))
            .string(text)
            .toBytes(),
        );
        this.emitFrame(new Uint8Array([Push.MsgWaiting]));
      }, ms),
    );
  }

  private runCli(p: Person, command: string): string | null {
    const prefs = this.prefs.get(p)!;
    const get = /^get (\S+)$/.exec(command);
    const set = /^set (\S+) (.*)$/.exec(command);
    const now = new Date();
    const clock = `${now.toISOString().slice(11, 16)} - ${now.getUTCDate()}/${now.getUTCMonth() + 1}/${now.getUTCFullYear()} UTC`;
    if (command === "ver") return "v1.17.1 (Build: 14-Aug-2026)";
    if (command === "board") return "Demo board";
    if (command === "clock") return clock;
    if (command === "clock sync") return `OK - clock set: ${clock}`;
    if (command === "advert") return "OK - Advert sent";
    if (command === "advert.zerohop") return "OK - zerohop advert sent";
    if (command === "clear stats") return "OK";
    if (command === "reboot") return null;
    if (command === "neighbors") return NEIGHBOURS.slice(0, 5).map(([prefix, secs, snr]) => `${prefix.slice(0, 8)}:${secs}:${snr * 4}`).join("\n");
    if (command === "powersaving") return prefs["powersaving"]!;
    if (command === "powersaving on" || command === "powersaving off") {
      prefs["powersaving"] = command.slice(12);
      return command.endsWith("on") ? "on - After 2 minutes" : "off";
    }
    if (command.startsWith("password ")) return `password now: ${command.slice(9)}`;
    if (command.startsWith("tempradio ")) return `OK - temp params for ${command.split(",").pop()} mins`;
    if (command.startsWith("setperm ")) return "OK";
    if (get) return get[1]! in prefs ? `> ${prefs[get[1]!]}` : `??: ${get[1]}`;
    if (set) {
      if (!(set[1]! in prefs)) return `unknown config: ${set[1]}`;
      prefs[set[1]!] = set[2]!;
      if (set[1] === "radio") return "OK - reboot to apply";
      if (set[1] === "repeat") return `OK - repeat is now ${set[2] === "on" ? "ON" : "OFF"}`;
      return "OK";
    }
    return "Unknown command";
  }

  private binary(p: Person, tag: number, req: Uint8Array): Uint8Array | null {
    const w = new ByteWriter().u8(Push.BinaryResponse).u8(0).u32(tag);
    switch (req[0]) {
      case ReqType.GetNeighbours: {
        const count = req[2] ?? 10;
        const offset = (req[3] ?? 0) | ((req[4] ?? 0) << 8);
        const order = req[5] ?? 0;
        const sorted = [...NEIGHBOURS].sort((a, b) => (order === 0 ? a[1] - b[1] : order === 1 ? b[1] - a[1] : order === 2 ? b[2] - a[2] : a[2] - b[2]));
        const page = sorted.slice(offset, offset + Math.min(count, 11));
        w.u16(NEIGHBOURS.length).u16(page.length);
        for (const [prefix, secs, snr] of page) w.bytes(fromHex(prefix)).u32(secs).i8(Math.round(snr * 4));
        return w.toBytes();
      }
      case ReqType.GetAccessList:
        if (!this.admins.has(p)) return null;
        w.bytes(SELF.subarray(0, 6)).u8(3).bytes(PEOPLE[0]!.key.subarray(0, 6)).u8(3);
        if (p.type !== 3) w.bytes(PEOPLE[1]!.key.subarray(0, 6)).u8(2).bytes(fromHex("91c2e0a1b2c3")).u8(1);
        return w.toBytes();
      case ReqType.GetOwnerInfo:
        return w.string(`v1.17.1\n${p.name}\n${this.prefs.get(p)!["owner.info"]!.replace(/\|/g, "\n")}`).toBytes();
      case ReqType.GetAvgMinMax: {
        const span = (req[1] ?? 0) | ((req[2] ?? 0) << 8) | ((req[3] ?? 0) << 16);
        const wide = Math.min(1, span / (7 * 86400));
        const be = (v: number) => new Uint8Array([(v >> 8) & 0xff, v & 0xff]);
        const series = (type: number, scale: number, min: number, max: number, avg: number) =>
          w.u8(1).u8(type).bytes(be(Math.round(min * scale))).bytes(be(Math.round(max * scale))).bytes(be(Math.round(avg * scale)));
        w.u32(Math.floor(Date.now() / 1000));
        series(0x67, 10, 13.6 - 7 * wide, 14.4 + 7 * wide, 14.0 - 1.5 * wide);
        series(0x68, 10, 69 - 20 * wide, 72 + 22 * wide, 70.5);
        series(0x73, 10, 1012.1 - 14 * wide, 1012.5 + 7 * wide, 1012.3 - 4 * wide);
        series(0x74, 100, 3.97 - 0.12 * wide, 3.98 + 0.08 * wide, 3.98 - 0.02 * wide);
        return w.toBytes();
      }
      default:
        return null;
    }
  }

  async send(frame: Uint8Array): Promise<void> {
    const replies = this.answer(frame);
    const t = setTimeout(() => {
      for (const r of replies) this.emitFrame(r);
    }, 15);
    this.timers.push(t);
  }

  private later(ms: number, frame: Uint8Array | (() => void)): void {
    this.timers.push(setTimeout(() => (typeof frame === "function" ? frame() : this.emitFrame(frame)), ms));
  }

  private answer(frame: Uint8Array): Uint8Array[] {
    const code = frame[0];
    switch (code) {
      case Cmd.DeviceQuery:
        return [
          new ByteWriter()
            .u8(Resp.DeviceInfo)
            .u8(13)
            .u8(50)
            .u8(8)
            .u32(123456)
            .fixedString("14 Aug 2026", 12)
            .fixedString("Demo board", 40)
            .fixedString("v1.17.1", 20)
            .u8(0)
            .u8(0)
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
            .i32(55_020_000)
            .i32(73_360_000)
            .u8(0)
            .u8(1)
            .u8(2)
            .u8(0)
            .u32(869_161)
            .u32(62_500)
            .u8(7)
            .u8(7)
            .string("Demo radio")
            .toBytes(),
        ];
      case Cmd.GetDeviceTime:
        return [new ByteWriter().u8(Resp.CurrTime).u32(Math.floor(Date.now() / 1000)).toBytes()];
      case Cmd.GetContacts: {
        const kept = PEOPLE.filter((p) => !this.gone.has(p));
        // The radio stamps a contact with the moment it stored its last advert.
        const stamp = (p: Person) => Math.floor(Date.now() / 1000) - (p.ago ?? 600);
        return [
          new ByteWriter().u8(Resp.ContactsStart).u32(kept.length).toBytes(),
          ...kept.map((p) => contactFrame(Resp.Contact, p, stamp(p), this.routes.get(p), this.paths.get(p), this.flags.get(p))),
          new ByteWriter().u8(Resp.EndOfContacts).u32(Math.floor(Date.now() / 1000)).toBytes(),
        ];
      }
      case Cmd.RemoveContact: {
        const p = this.person(frame.subarray(1, 33));
        if (!p) return [new Uint8Array([Resp.Err, 2])];
        this.gone.add(p);
        return [new Uint8Array([Resp.Ok])];
      }
      case Cmd.GetAutoAddConfig:
        return [new Uint8Array([Resp.AutoAddConfig, this.autoAdd.config, this.autoAdd.maxHops])];
      case Cmd.SetAutoAddConfig:
        this.autoAdd = { config: frame[1] ?? 0, maxHops: frame[2] ?? 0 };
        return [new Uint8Array([Resp.Ok])];
      case Cmd.GetContactByKey: {
        const p = this.person(frame.subarray(1, 33));
        return p ? [contactFrame(Resp.Contact, p, Math.floor(Date.now() / 1000), this.routes.get(p), this.paths.get(p), this.flags.get(p))] : [new Uint8Array([Resp.Err, 2])];
      }
      case Cmd.ResetPath: {
        const p = this.person(frame.subarray(1, 33));
        if (p) this.routes.set(p, 0xff);
        return [new Uint8Array([Resp.Ok])];
      }
      case Cmd.SendChannelTxtMsg: {
        // Repeaters send it on, and the radio overhears them.
        const index = frame[2] ?? 0;
        const timestamp = (frame[3]! | (frame[4]! << 8) | (frame[5]! << 16) | (frame[6]! << 24)) >>> 0;
        const text = fromUtf8(frame.subarray(7));
        // On Friends the repeaters miss the first send of every text, so a
        // message there turns unheard and a second send gets through.
        if (index === 1 && !this.missed.has(text)) {
          this.missed.add(text);
          return [new Uint8Array([Resp.Ok])];
        }
        void groupTextPayload(fromHex(CHANNELS[index] ?? CHANNELS[0]!), timestamp, "Demo radio", text).then((payload) => {
          [[0x03], [0x03, 0x94], [0x2c]].forEach((path, i) => this.later(600 * (i + 1), this.heard(5, path, payload)));
        });
        return [new Uint8Array([Resp.Ok])];
      }
      case Cmd.GetChannel: {
        const index = frame[1] ?? 0;
        if (index === 0) return [new ByteWriter().u8(Resp.ChannelInfo).u8(0).fixedString("Public", 32).bytes(fromHex(CHANNELS[0]!)).toBytes()];
        if (index === 1) return [new ByteWriter().u8(Resp.ChannelInfo).u8(1).fixedString("Friends", 32).bytes(fromHex(CHANNELS[1]!)).toBytes()];
        return [new ByteWriter().u8(Resp.ChannelInfo).u8(index).fixedString("", 32).zeros(16).toBytes()];
      }
      case Cmd.SyncNextMessage:
        return [this.queue.shift() ?? new Uint8Array([Resp.NoMoreMessages])];
      case Cmd.GetBattAndStorage:
        return [new ByteWriter().u8(Resp.BattAndStorage).u16(3980).u32(120).u32(1024).toBytes()];
      case Cmd.GetTuningParams:
        return [new ByteWriter().u8(Resp.TuningParams).u32(0).u32(1000).toBytes()];
      case Cmd.SendTxtMsg: {
        if (frame[1] === TxtType.CliData) {
          const p = this.person(frame.subarray(7, 13));
          const text = fromUtf8(frame.subarray(13));
          const tagged = /^([0-9a-f]{2})\|(.*)$/s.exec(text);
          // Like the firmware: the console answers admins, and a stranger hears nothing.
          if (p && this.prefs.has(p) && this.admins.has(p)) {
            const reply = this.runCli(p, tagged ? tagged[2]! : text);
            if (reply !== null) this.cliReply(p, tagged ? `${tagged[1]}|${reply}` : reply);
          }
          return [this.sent(0)];
        }
        const p = this.person(frame.subarray(7, 13));
        const tag = this.acks++;
        const confirmed = new ByteWriter().u8(Push.SendConfirmed).u32(tag).u32(1400).toBytes();
        const flood = !p || this.routes.get(p) === 0xff;
        if (flood) {
          // The acknowledgement rides back on the route the flood took: the radio learns it first.
          this.later(1500 + Math.random() * 1500, () => {
            if (p) {
              this.routes.set(p, 1 + Math.floor(Math.random() * 3));
              this.emitFrame(new ByteWriter().u8(Push.PathUpdated).bytes(p.key).toBytes());
            }
            this.emitFrame(confirmed);
          });
        } else if (!(p.name.startsWith("Bob") && Math.random() < 0.6)) {
          // Bob is on his bike: more often than not, the route he was last reached by is gone.
          this.later(900 + Math.random() * 1500, confirmed);
        }
        return [new ByteWriter().u8(Resp.Sent).u8(flood ? 1 : 0).u32(tag).u32(3000).toBytes()];
      }
      case Cmd.SendLogin: {
        const p = this.person(frame.subarray(1, 33));
        const password = fromUtf8(frame.subarray(33));
        if (!p || !this.prefs.has(p)) return [new Uint8Array([Resp.Err, 2])];
        if (password === "wrong" || (p.type === 4 && password === "guest")) {
          this.later(1400, new ByteWriter().u8(Push.LoginFail).u8(0).bytes(p.key.subarray(0, 6)).toBytes());
        } else {
          // "guest" signs in as a guest (a room's guests may post); anything else, blank included, as admin.
          const guest = password === "guest";
          if (guest) this.admins.delete(p);
          else this.admins.add(p);
          // The repeater's clock runs 47 s behind, for the clock card.
          const drift = p.type === 2 ? 47 : 2;
          this.later(
            1400,
            new ByteWriter()
              .u8(Push.LoginSuccess)
              .u8(guest ? 0 : 1)
              .bytes(p.key.subarray(0, 6))
              .u32(Math.floor(Date.now() / 1000) - drift)
              .u8(guest ? (p.type === 3 ? 2 : 0) : 3)
              .u8(p.type === 2 ? 2 : 1)
              .toBytes(),
          );
        }
        return [new ByteWriter().u8(Resp.Sent).u8(0).bytes(p.key.subarray(0, 4)).u32(2500).toBytes()];
      }
      case Cmd.SendStatusReq: {
        const p = this.person(frame.subarray(1, 33));
        const room = p?.type === 3;
        const hours = (Date.now() / 3_600_000) % 24;
        const mv = room ? 4200 : Math.round(4050 + 80 * Math.sin((hours / 24) * Math.PI * 2) + Math.random() * 20);
        const w = new ByteWriter()
          .u8(Push.StatusResponse)
          .u8(0)
          .bytes(frame.subarray(1, 7))
          .u16(mv)
          .u16(Math.random() < 0.8 ? 0 : 2)
          .u16((-112 + Math.round(Math.random() * 4)) & 0xffff)
          .u16(-98 & 0xffff)
          .u32(48213)
          .u32(21907)
          .u32(22080)
          .u32(86400 * 12 + 4 * 3600)
          .u32(19204)
          .u32(2703)
          .u32(41880)
          .u32(6333)
          .u16(0)
          .u16(25)
          .u16(88)
          .u16(9412);
        if (room) w.u16(184).u16(1203);
        else w.u32(111_600).u32(12);
        this.later(1500, w.toBytes());
        return [this.sent(this.acks++)];
      }
      case Cmd.SendTelemetryReq: {
        const prefix = frame.length > 4 ? frame.subarray(4, 10) : SELF.subarray(0, 6);
        this.later(
          frame.length > 4 ? 1500 : 50,
          new ByteWriter()
            .u8(Push.TelemetryResponse)
            .u8(0)
            .bytes(prefix)
            .bytes(new Uint8Array([1, 0x74, 0x01, 0x8e, 1, 0x67, 0x00, 0xd2, 2, 0x68, 0x5a]))
            .toBytes(),
        );
        return frame.length > 4 ? [this.sent(this.acks++)] : [];
      }
      case Cmd.SendBinaryReq: {
        const p = this.person(frame.subarray(1, 33));
        const tag = this.acks++;
        const reply = p ? this.binary(p, tag, frame.subarray(33)) : null;
        if (reply) this.later(1600, reply);
        return [this.sent(tag, p?.hops === 0xff)];
      }
      case Cmd.SendPathDiscoveryReq: {
        // The flood finds a shorter way than the one held, when there is one to shorten; the answer comes back the other way round.
        const p = this.person(frame.subarray(2, 34));
        if (!p) return [new Uint8Array([Resp.Err, 2])];
        const held = this.paths.get(p) ?? (p.hops === 0xff ? [RELAYS[0]!] : RELAYS.slice(0, p.hops));
        const out = held.length > 1 ? [held[0]!, ...held.slice(2)] : held;
        const back = out.slice().reverse();
        this.later(2200, new ByteWriter().u8(Push.PathDiscoveryResponse).u8(0).bytes(p.key.subarray(0, 6)).u8(out.length).bytes(new Uint8Array(out)).u8(back.length).bytes(new Uint8Array(back)).toBytes());
        return [new ByteWriter().u8(Resp.Sent).u8(1).u32(this.acks++).u32(3000).toBytes()];
      }
      case Cmd.SendTracePath: {
        // Out along the path and back: each node adds how well it heard the one before, and any hop may lose it.
        const tag = frame.subarray(1, 5);
        const flags = frame[9] ?? 0;
        const size = 1 << (flags & 3);
        const path = frame.subarray(10);
        const hashes = Array.from({ length: path.length / size }, (_, i) => path[i * size]!);
        const snrs = hashes.map(heardAt);
        const final = heardAt(hashes[0]!) - 1;
        const back = snrs.every(through) && through(final);
        const estimate = 500 + (160 * 6 + 250) * (hashes.length + 1);
        if (back) {
          const trip = 170 * (hashes.length + 1) + Math.random() * 90 * hashes.length;
          this.later(
            trip,
            new ByteWriter()
              .u8(Push.TraceData)
              .u8(0)
              .u8(path.length)
              .u8(flags)
              .bytes(tag)
              .u32(0)
              .bytes(path)
              .bytes(new Uint8Array(snrs.map((s) => Math.round(s * 4) & 0xff)))
              .i8(Math.round(final * 4))
              .toBytes(),
          );
        }
        return [new ByteWriter().u8(Resp.Sent).u8(0).bytes(tag).u32(estimate).toBytes()];
      }
      case Cmd.SendControlData: {
        // Who hears me: the repeaters in range answer after a pause of their own, with how they heard us.
        if (((frame[1] ?? 0) & 0xf0) === 0x80) {
          const tag = frame.subarray(3, 7);
          for (const p of PEOPLE.filter((x) => x.type === 2 && x.hops <= 1)) {
            if (Math.random() < 0.15) continue;
            const us = heardAt(p.key[0]!);
            const them = heardAt(p.key[0]!) + 1;
            this.later(
              500 + Math.random() * 6000,
              new ByteWriter()
                .u8(Push.ControlData)
                .i8(Math.round(them * 4))
                .i8(-100 + Math.round(them * 2))
                .u8(0)
                .u8(0x92)
                .i8(Math.round(us * 4))
                .bytes(tag)
                .bytes(p.key)
                .toBytes(),
            );
          }
        }
        return [new Uint8Array([Resp.Ok])];
      }
      case Cmd.GetStats:
        if (frame[1] !== 1) return [new Uint8Array([Resp.Err, 1])];
        return [
          new ByteWriter()
            .u8(Resp.Stats)
            .u8(1)
            .u16((-114 + Math.round(Math.random() * 4)) & 0xffff)
            .i8(-96)
            .i8(26)
            .u32(412)
            .u32(9120)
            .toBytes(),
        ];
      case Cmd.GetAdvertPath: {
        const p = this.person(frame.subarray(2, 34));
        if (!p || p.hops === 0xff) return [new Uint8Array([Resp.Err, 2])];
        // An advert comes in the other way round: its first relay is the one nearest to it.
        const relays = (this.paths.get(p) ?? RELAYS.slice(0, p.hops)).slice().reverse();
        return [new ByteWriter().u8(Resp.AdvertPath).u32(Math.floor(Date.now() / 1000) - 900).u8(relays.length).bytes(new Uint8Array(relays)).toBytes()];
      }
      case Cmd.AddUpdateContact: {
        const key = frame.subarray(1, 33);
        const p = PEOPLE.find((x) => key.every((b, i) => b === x.key[i]));
        const length = frame[35] ?? 0xff;
        if (p) {
          this.gone.delete(p);
          this.flags.set(p, frame[34] ?? 0);
          this.routes.set(p, length);
          if (length !== 0xff) this.paths.set(p, Array.from(frame.subarray(36, 36 + (length & 63))));
        }
        return [new Uint8Array([Resp.Ok])];
      }
      case Cmd.Reboot:
        this.timers.push(setTimeout(() => this.emitClose(new Error("the radio rebooted")), 200));
        return [];
      default:
        // Everything else is a setting: say yes.
        return [new Uint8Array([Resp.Ok])];
    }
  }

  protected async shutdown(): Promise<void> {
    for (const t of this.timers) clearTimeout(t);
    if (this.chatter) clearInterval(this.chatter);
    if (this.murmur) clearInterval(this.murmur);
  }
}

export const demoConnector: Connector = {
  id: "demo",
  kind: "ble",
  title: "Demo",
  description: "A pretend radio, for a look around without hardware.",
  mode: "scan",
  async scan(onFound) {
    onFound([{ id: "demo", name: "MeshCore-demo", detail: "no hardware", rssi: -42 }]);
  },
  async remembered() {
    return [];
  },
  async connect(): Promise<Transport> {
    const radio = new DemoRadio();
    radio.start();
    return radio;
  },
};

export function demoWanted(): boolean {
  return import.meta.env.DEV || new URLSearchParams(window.location.search).has("demo");
}
