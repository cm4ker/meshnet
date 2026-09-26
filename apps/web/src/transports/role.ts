/**
 * What a found device is, and what the connect screen calls it. The firmware
 * advertises a radio as `MeshCore-<node>`; the iPhone app shares its radio as
 * `Ommesh <node>`, Android under the phone's own name. The Bluetooth lists
 * hold only what carries the radio's service or name, so anything else in
 * one is a phone sharing a radio.
 */

import type { TransportKind } from "@meshnet/meshcore";
import type { DeviceRole, FoundDevice } from "./types.js";

const RADIO = /^MeshCore(?:-(.+))?$/;
const IPHONE = /^Ommesh(?: (.+))?$/;

export function roleOf(device: FoundDevice, kind: TransportKind): DeviceRole {
  if (device.role) return device.role;
  if (kind !== "ble") return "radio";
  return RADIO.test(device.name) ? "radio" : "phone";
}

/** The name without the firmware's prefix; an iPhone sharing a radio is called what it is. */
export function shownName(device: FoundDevice, kind: TransportKind): string {
  if (kind !== "ble") return device.name;
  if (IPHONE.test(device.name)) return "iPhone";
  return RADIO.exec(device.name)?.[1]?.trim() || device.name;
}

/** The radio an iPhone shares, by the name it advertises; null when the advert does not say. */
export function sharedRadio(device: FoundDevice): string | null {
  return IPHONE.exec(device.name)?.[1]?.trim() || null;
}

const MAC = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i;

/** A Bluetooth address to tell two radios of one name apart, where the platform gives one (not iOS). */
export function bleAddress(device: FoundDevice): string | null {
  return [device.detail, device.id].find((s): s is string => s !== null && MAC.test(s)) ?? null;
}
