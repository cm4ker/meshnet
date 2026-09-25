import { useSyncExternalStore } from "react";
import type { BatteryType } from "./format.js";
import { readSetting, writeSetting } from "./storage.js";

/**
 * What each radio's cell is made of (#26), by the radio's public key. The
 * radio reports only volts and the firmware has no setting for the cell, so
 * the app keeps it and turns the volts into a percent with it. Only a radio
 * other than Li-ion is written down.
 */

const KEY = "meshnet.batteryTypes";

export const BATTERY_TYPES: { value: BatteryType; label: string; hint: string }[] = [
  { value: "liion", label: "Li-ion / LiPo", hint: "3.0–4.2 V · most boards" },
  { value: "lifepo4", label: "LiFePO4", hint: "2.5–3.65 V · solar builds" },
];

function restore(saved: unknown): Record<string, BatteryType> {
  if (!saved || typeof saved !== "object") return {};
  const types: Record<string, BatteryType> = {};
  for (const [key, type] of Object.entries(saved)) if (type === "lifepo4") types[key] = type;
  return types;
}

let types = restore(readSetting<unknown>(KEY, null));
const listeners = new Set<() => void>();

export function batteryType(radioKey: string | undefined): BatteryType {
  return (radioKey && types[radioKey]) || "liion";
}

export function batteryTypeLabel(type: BatteryType): string {
  return BATTERY_TYPES.find((t) => t.value === type)?.label ?? type;
}

export function setBatteryType(radioKey: string, type: BatteryType): void {
  const next = { ...types };
  if (type === "liion") delete next[radioKey];
  else next[radioKey] = type;
  types = next;
  writeSetting(KEY, Object.keys(next).length > 0 ? next : null);
  for (const listener of listeners) listener();
}

export function useBatteryType(radioKey: string | undefined): BatteryType {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => batteryType(radioKey),
  );
}
