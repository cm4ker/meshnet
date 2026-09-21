/**
 * Every frame in either direction, for the log pane. Kept out of the session's
 * state because it changes on every byte and nothing but the log reads it.
 */

import { toHex, type Frame } from "@meshnet/meshcore";
import { useSyncExternalStore } from "react";

export interface TraceEntry {
  at: number;
  direction: "in" | "out";
  hex: string;
  kind: string;
}

const LIMIT = 300;
let entries: TraceEntry[] = [];
const listeners = new Set<() => void>();
let enabled = false;

export function pushTrace(direction: "in" | "out", bytes: Uint8Array, frame?: Frame): void {
  if (!enabled) return;
  const entry: TraceEntry = {
    at: Date.now(),
    direction,
    hex: toHex(bytes),
    kind: frame ? frame.kind : `cmd 0x${(bytes[0] ?? 0).toString(16).padStart(2, "0")}`,
  };
  entries = entries.length >= LIMIT ? [...entries.slice(-LIMIT + 1), entry] : [...entries, entry];
  for (const listener of listeners) listener();
}

export function setTraceEnabled(on: boolean): void {
  enabled = on;
  if (!on) {
    entries = [];
    for (const listener of listeners) listener();
  }
}

export function isTraceEnabled(): boolean {
  return enabled;
}

export function useTrace(): TraceEntry[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => entries,
  );
}
