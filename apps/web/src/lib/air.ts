/**
 * What the radio hears, for the "On the air" page: every packet it hands up,
 * whoever it was for, and its noise floor asked of the radio every ten
 * seconds. Kept only while the page is open, the last 500 packets; nothing
 * of it goes on the air.
 */

import { useEffect, useSyncExternalStore } from "react";
import { PayloadType, type HeardPacket, type RadioStats } from "@meshnet/meshcore";
import { session } from "./session.js";

const KEEP = 500;
const STATS_EVERY_MS = 10_000;
const NOISE_KEEP = 36;

export interface AirState {
  packets: (HeardPacket & { id: number })[];
  noise: number[];
  stats: RadioStats | null;
}

let state: AirState = { packets: [], noise: [], stats: null };
const listeners = new Set<() => void>();
let seq = 0;
let watchers = 0;
let stop: (() => void) | null = null;

function set(next: AirState): void {
  state = next;
  for (const listener of listeners) listener();
}

function watch(): () => void {
  const off = session.onHeard((packet) => {
    set({ ...state, packets: [{ ...packet, id: ++seq }, ...state.packets].slice(0, KEEP) });
  });
  const read = () => {
    if (!session.isReady) return;
    session
      .radioStats()
      .then((stats) => set({ ...state, stats, noise: [...state.noise, stats.noiseFloor].slice(-NOISE_KEEP) }))
      .catch(() => undefined);
  };
  read();
  const timer = setInterval(read, STATS_EVERY_MS);
  return () => {
    off();
    clearInterval(timer);
  };
}

/** The page's view of the air; listening starts with the first page open and ends with the last. */
export function useAir(): AirState {
  useEffect(() => {
    if (watchers++ === 0) stop = watch();
    return () => {
      if (--watchers === 0) {
        stop?.();
        stop = null;
        set({ packets: [], noise: [], stats: null });
      }
    };
  }, []);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

const NAMES: Record<number, string> = {
  [PayloadType.Req]: "REQ",
  [PayloadType.Response]: "RESPONSE",
  [PayloadType.TxtMsg]: "TXT_MSG",
  [PayloadType.Ack]: "ACK",
  [PayloadType.Advert]: "ADVERT",
  [PayloadType.GroupText]: "GRP_TXT",
  [PayloadType.GroupData]: "GRP_DATA",
  [PayloadType.AnonReq]: "ANON_REQ",
  [PayloadType.Path]: "PATH",
  [PayloadType.Trace]: "TRACE",
  [PayloadType.Multipart]: "MULTIPART",
  [PayloadType.Control]: "CONTROL",
  [PayloadType.RawCustom]: "RAW",
};

export function typeName(payloadType: number): string {
  return NAMES[payloadType] ?? `TYPE ${payloadType}`;
}

/** Messages, adverts, and everything that keeps the mesh running. */
export function typeKind(payloadType: number): "msg" | "adv" | "svc" {
  if (payloadType === PayloadType.TxtMsg || payloadType === PayloadType.GroupText || payloadType === PayloadType.GroupData) return "msg";
  return payloadType === PayloadType.Advert ? "adv" : "svc";
}
