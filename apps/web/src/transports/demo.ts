/**
 * A radio that is not there: a scripted one, for looking at the client with
 * no hardware on the desk. Offered when the page is opened with `?demo`, or
 * in development. It has a few contacts and channels, answers every command
 * the session sends, acknowledges messages a moment later, and has somebody
 * say something every so often.
 */

import { BaseTransport, ByteWriter, Cmd, fromHex, Push, Resp, TxtType, type Transport } from "@meshnet/meshcore";
import type { Connector } from "./types.js";

const SELF = fromHex("a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf");

interface Person {
  key: Uint8Array;
  name: string;
  type: number;
  hops: number;
  lat: number;
  lon: number;
}

const PEOPLE: Person[] = [
  { key: seeded(1), name: "Alice", type: 1, hops: 0, lat: 55.03, lon: 73.37 },
  { key: seeded(2), name: "Bob (bike)", type: 1, hops: 1, lat: 0, lon: 0 },
  { key: seeded(3), name: "Hill Repeater", type: 2, hops: 1, lat: 55.05, lon: 73.4 },
  { key: seeded(4), name: "Town Room", type: 3, hops: 2, lat: 0, lon: 0 },
  { key: seeded(5), name: "Weather sensor", type: 4, hops: 0xff, lat: 55.01, lon: 73.3 },
];

function seeded(n: number): Uint8Array {
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) key[i] = (n * 37 + i * 11) & 0xff;
  return key;
}

function contactFrame(code: number, p: Person, lastMod: number): Uint8Array {
  const path = new Uint8Array(64);
  for (let i = 0; i < 64; i++) path[i] = (i * 7 + 3) & 0xff;
  return new ByteWriter()
    .u8(code)
    .bytes(p.key)
    .u8(p.type)
    .u8(p.name === "Alice" ? 1 : 0)
    .u8(p.hops)
    .bytes(path)
    .fixedString(p.name, 32)
    .u32(Math.floor(Date.now() / 1000) - 600)
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

class DemoRadio extends BaseTransport {
  readonly kind = "ble" as const;
  readonly label = "MeshCore-demo";
  private queue: Uint8Array[] = [];
  private timers: ReturnType<typeof setTimeout>[] = [];
  private chatter: ReturnType<typeof setInterval> | null = null;
  private acks = 0x1000;

  start(): void {
    this.queue.push(this.dm(PEOPLE[0]!, "Welcome to the demo mesh 👋"), this.channel(0, "Bob (bike)", "Public channel works too"));
    this.chatter = setInterval(() => {
      const who = PEOPLE[Math.floor(Math.random() * 2)]!;
      const line = LINES[Math.floor(Math.random() * LINES.length)]!;
      if (Math.random() < 0.5) this.queue.push(this.channel(0, who.name, line));
      else this.queue.push(this.dm(who, line));
      this.emitFrame(new Uint8Array([Push.MsgWaiting]));
    }, 25_000);
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

  private channel(index: number, sender: string, text: string): Uint8Array {
    return new ByteWriter()
      .u8(Resp.ChannelMsgRecvV3)
      .i8(Math.round((Math.random() * 20 - 5) * 4))
      .u8(0)
      .u8(0)
      .u8(index)
      .u8(1)
      .u8(TxtType.Plain)
      .u32(Math.floor(Date.now() / 1000))
      .string(`${sender}: ${text}`)
      .toBytes();
  }

  async send(frame: Uint8Array): Promise<void> {
    const replies = this.answer(frame);
    const t = setTimeout(() => {
      for (const r of replies) this.emitFrame(r);
    }, 15);
    this.timers.push(t);
  }

  private later(ms: number, frame: Uint8Array): void {
    this.timers.push(setTimeout(() => this.emitFrame(frame), ms));
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
      case Cmd.GetContacts:
        return [
          new ByteWriter().u8(Resp.ContactsStart).u32(PEOPLE.length).toBytes(),
          ...PEOPLE.map((p, i) => contactFrame(Resp.Contact, p, 100 + i)),
          new ByteWriter().u8(Resp.EndOfContacts).u32(100 + PEOPLE.length).toBytes(),
        ];
      case Cmd.GetChannel: {
        const index = frame[1] ?? 0;
        if (index === 0) return [new ByteWriter().u8(Resp.ChannelInfo).u8(0).fixedString("Public", 32).bytes(fromHex("8b3387e9c5cdea6ac9e5edbaa115cd72")).toBytes()];
        if (index === 1) return [new ByteWriter().u8(Resp.ChannelInfo).u8(1).fixedString("Friends", 32).bytes(fromHex("0123456789abcdef0123456789abcdef")).toBytes()];
        return [new ByteWriter().u8(Resp.ChannelInfo).u8(index).fixedString("", 32).zeros(16).toBytes()];
      }
      case Cmd.SyncNextMessage:
        return [this.queue.shift() ?? new Uint8Array([Resp.NoMoreMessages])];
      case Cmd.GetBattAndStorage:
        return [new ByteWriter().u8(Resp.BattAndStorage).u16(3980).u32(120).u32(1024).toBytes()];
      case Cmd.GetTuningParams:
        return [new ByteWriter().u8(Resp.TuningParams).u32(0).u32(1000).toBytes()];
      case Cmd.SendTxtMsg: {
        const tag = this.acks++;
        this.later(900 + Math.random() * 2000, new ByteWriter().u8(Push.SendConfirmed).u32(tag).u32(1400).toBytes());
        return [new ByteWriter().u8(Resp.Sent).u8(frame[2] === 0 ? 0 : 1).u32(tag).u32(3000).toBytes()];
      }
      case Cmd.SendLogin:
        this.later(1200, new ByteWriter().u8(Push.LoginSuccess).u8(1).bytes(frame.subarray(1, 7)).u32(Math.floor(Date.now() / 1000)).u8(0).u8(3).toBytes());
        return [new ByteWriter().u8(Resp.Sent).u8(0).u32(this.acks++).u32(3000).toBytes()];
      case Cmd.SendStatusReq:
        this.later(
          1500,
          new ByteWriter()
            .u8(Push.StatusResponse)
            .u8(0)
            .bytes(frame.subarray(1, 7))
            .u16(4050).u16(0).u16(0xff9c & 0xffff).u16(0xffa6 & 0xffff)
            .u32(12345).u32(11000).u32(3600).u32(86400 * 3)
            .u32(200).u32(300).u32(6000).u32(4000)
            .u16(2).u16(30).u16(5).u16(40).u32(7200).u32(12)
            .toBytes(),
        );
        return [new ByteWriter().u8(Resp.Sent).u8(0).u32(this.acks++).u32(3000).toBytes()];
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
        return frame.length > 4 ? [new ByteWriter().u8(Resp.Sent).u8(0).u32(this.acks++).u32(3000).toBytes()] : [];
      }
      case Cmd.SendPathDiscoveryReq:
        this.later(1800, new ByteWriter().u8(Push.PathDiscoveryResponse).u8(0).bytes(frame.subarray(2, 8)).u8(2).bytes(fromHex("a1b2")).u8(2).bytes(fromHex("b2a1")).toBytes());
        return [new ByteWriter().u8(Resp.Sent).u8(1).u32(this.acks++).u32(3000).toBytes()];
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
