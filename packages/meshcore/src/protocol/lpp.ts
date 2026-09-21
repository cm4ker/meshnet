/**
 * Cayenne Low Power Payload, which is how the firmware packs telemetry: a
 * channel byte, a type byte, then the value in the type's width.
 *
 * The types and scales are the ones in the firmware's `CayenneLPP.h`. A type
 * this decoder does not know stops the parse and is reported as `unknown`,
 * because its width is unknown too and everything after it would be guessed.
 */

import { ByteReader } from "./bytes.js";

export type LppReading =
  | { channel: number; type: "digitalIn"; value: number }
  | { channel: number; type: "digitalOut"; value: number }
  | { channel: number; type: "analogIn"; value: number }
  | { channel: number; type: "analogOut"; value: number }
  | { channel: number; type: "genericSensor"; value: number }
  | { channel: number; type: "luminosity"; lux: number }
  | { channel: number; type: "presence"; value: number }
  | { channel: number; type: "temperature"; celsius: number }
  | { channel: number; type: "humidity"; percent: number }
  | { channel: number; type: "accelerometer"; x: number; y: number; z: number }
  | { channel: number; type: "barometer"; hpa: number }
  | { channel: number; type: "voltage"; volts: number }
  | { channel: number; type: "current"; amps: number }
  | { channel: number; type: "frequency"; hz: number }
  | { channel: number; type: "percentage"; percent: number }
  | { channel: number; type: "altitude"; meters: number }
  | { channel: number; type: "concentration"; ppm: number }
  | { channel: number; type: "power"; watts: number }
  | { channel: number; type: "distance"; meters: number }
  | { channel: number; type: "energy"; kwh: number }
  | { channel: number; type: "direction"; degrees: number }
  | { channel: number; type: "unixTime"; seconds: number }
  | { channel: number; type: "gyrometer"; x: number; y: number; z: number }
  | { channel: number; type: "colour"; r: number; g: number; b: number }
  | { channel: number; type: "gps"; lat: number; lon: number; alt: number }
  | { channel: number; type: "switch"; value: number }
  | { channel: number; type: "unknown"; code: number; rest: Uint8Array };

/** The channel the firmware reports its own battery and MCU on. */
export const LPP_CHANNEL_SELF = 1;

function i24(r: ByteReader): number {
  const b0 = r.u8();
  const b1 = r.u8();
  const b2 = r.u8();
  let v = (b0 << 16) | (b1 << 8) | b2;
  if (v & 0x800000) v -= 0x1000000;
  return v;
}

function i16be(r: ByteReader): number {
  const hi = r.u8();
  const lo = r.u8();
  const v = (hi << 8) | lo;
  return v & 0x8000 ? v - 0x10000 : v;
}

function u16be(r: ByteReader): number {
  const hi = r.u8();
  const lo = r.u8();
  return (hi << 8) | lo;
}

function u32be(r: ByteReader): number {
  return ((r.u8() << 24) | (r.u8() << 16) | (r.u8() << 8) | r.u8()) >>> 0;
}

export function decodeLpp(bytes: Uint8Array): LppReading[] {
  const r = new ByteReader(bytes);
  const out: LppReading[] = [];
  while (r.remaining >= 2) {
    const channel = r.u8();
    const type = r.u8();
    try {
      switch (type) {
        case 0x00:
          out.push({ channel, type: "digitalIn", value: r.u8() });
          break;
        case 0x01:
          out.push({ channel, type: "digitalOut", value: r.u8() });
          break;
        case 0x02:
          out.push({ channel, type: "analogIn", value: i16be(r) / 100 });
          break;
        case 0x03:
          out.push({ channel, type: "analogOut", value: i16be(r) / 100 });
          break;
        case 0x64:
          out.push({ channel, type: "genericSensor", value: u32be(r) });
          break;
        case 0x65:
          out.push({ channel, type: "luminosity", lux: u16be(r) });
          break;
        case 0x66:
          out.push({ channel, type: "presence", value: r.u8() });
          break;
        case 0x67:
          out.push({ channel, type: "temperature", celsius: i16be(r) / 10 });
          break;
        case 0x68:
          out.push({ channel, type: "humidity", percent: r.u8() / 2 });
          break;
        case 0x71:
          out.push({
            channel,
            type: "accelerometer",
            x: i16be(r) / 1000,
            y: i16be(r) / 1000,
            z: i16be(r) / 1000,
          });
          break;
        case 0x73:
          out.push({ channel, type: "barometer", hpa: u16be(r) / 10 });
          break;
        case 0x74:
          out.push({ channel, type: "voltage", volts: u16be(r) / 100 });
          break;
        case 0x75:
          out.push({ channel, type: "current", amps: u16be(r) / 1000 });
          break;
        case 0x76:
          out.push({ channel, type: "frequency", hz: u32be(r) });
          break;
        case 0x78:
          out.push({ channel, type: "percentage", percent: r.u8() });
          break;
        case 0x79:
          out.push({ channel, type: "altitude", meters: i16be(r) });
          break;
        case 0x7d:
          out.push({ channel, type: "concentration", ppm: u16be(r) });
          break;
        case 0x80:
          out.push({ channel, type: "power", watts: u16be(r) });
          break;
        case 0x82:
          out.push({ channel, type: "distance", meters: u32be(r) / 1000 });
          break;
        case 0x83:
          out.push({ channel, type: "energy", kwh: u32be(r) / 1000 });
          break;
        case 0x84:
          out.push({ channel, type: "direction", degrees: u16be(r) });
          break;
        case 0x85:
          out.push({ channel, type: "unixTime", seconds: u32be(r) });
          break;
        case 0x86:
          out.push({
            channel,
            type: "gyrometer",
            x: i16be(r) / 100,
            y: i16be(r) / 100,
            z: i16be(r) / 100,
          });
          break;
        case 0x87:
          out.push({ channel, type: "colour", r: r.u8(), g: r.u8(), b: r.u8() });
          break;
        case 0x88:
          out.push({ channel, type: "gps", lat: i24(r) / 10000, lon: i24(r) / 10000, alt: i24(r) / 100 });
          break;
        case 0x8e:
          out.push({ channel, type: "switch", value: r.u8() });
          break;
        default:
          out.push({ channel, type: "unknown", code: type, rest: r.rest() });
          return out;
      }
    } catch {
      // A value cut short at the end of the frame: keep what was whole.
      return out;
    }
  }
  return out;
}

const TYPE_NAMES: Record<number, Exclude<LppReading["type"], "unknown">> = {
  0x00: "digitalIn",
  0x01: "digitalOut",
  0x02: "analogIn",
  0x03: "analogOut",
  0x64: "genericSensor",
  0x65: "luminosity",
  0x66: "presence",
  0x67: "temperature",
  0x68: "humidity",
  0x71: "accelerometer",
  0x73: "barometer",
  0x74: "voltage",
  0x75: "current",
  0x76: "frequency",
  0x78: "percentage",
  0x79: "altitude",
  0x7d: "concentration",
  0x80: "power",
  0x82: "distance",
  0x83: "energy",
  0x84: "direction",
  0x85: "unixTime",
  0x86: "gyrometer",
  0x87: "colour",
  0x88: "gps",
  0x8e: "switch",
};

/** The name `decodeLpp` gives a type code, or `unknown`. */
export function lppTypeName(code: number): LppReading["type"] {
  return TYPE_NAMES[code] ?? "unknown";
}
