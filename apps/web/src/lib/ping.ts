/**
 * Pings to repeaters and checks of routes to people, kept per contact while
 * the app runs: five traces out along the route and back, one in flight at a
 * time, and on request one hop further at a time to find where a route
 * breaks. The route is the one the radio holds, or one being changed on the
 * map. Only a tap starts either; nothing here repeats on its own.
 */

import { useSyncExternalStore } from "react";
import { AdvType, traceLegs } from "@meshnet/meshcore";
import { session } from "./session.js";

export const ROUNDS = 5;
/** A hop that stays silent this many times is where the route breaks. */
const TRIES = 2;
/** Between one trace coming back and the next going out, so the relays' queues drain. */
const GAP_MS = 300;

/** How one leg sounded: the SNR at its far end going out, at its near end coming back. */
export type Leg = [out: number, back: number];

export interface PingRun {
  ok: boolean;
  rttMs: number | null;
  /** Leg by leg from this radio; empty when nothing came back. */
  legs: Leg[];
}

export interface HopCheck {
  state: "waiting" | "trying" | "ok" | "silent";
  tries: number;
  /** The leg ending at this hop, once it answered. */
  leg: Leg | null;
}

export interface Ping {
  key: string;
  /** What was traced: the relays, then the node itself when it relays too. */
  chain: string[];
  /** Whether the node is the last hop of the chain, or only reached through it. */
  targetInChain: boolean;
  /** The relays of a route being changed that it went along, as hashes; null for the route the radio holds. */
  via: string[] | null;
  mode: "rounds" | "hops";
  runs: PingRun[];
  hops: HopCheck[] | null;
  running: boolean;
  error: string | null;
  at: number;
}

const pings = new Map<string, Ping>();
const listeners = new Set<() => void>();
const stopped = new Set<string>();

function publish(ping: Ping): void {
  pings.set(ping.key, { ...ping });
  for (const listener of listeners) listener();
}

export function usePing(key: string | null): Ping | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (key ? (pings.get(key) ?? null) : null),
  );
}

export function getPing(key: string): Ping | null {
  return pings.get(key) ?? null;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The way a trace to this contact goes along relays given by hand: through them, and on to it when it relays too. */
function pathVia(key: string, via: string[]): { relays: string[]; target: string | null } | null {
  const state = session.getState();
  const contact = state.contacts[key];
  if (!contact) return null;
  const size = via[0] ? via[0].length / 2 : (state.device?.pathHashMode ?? 0) + 1;
  return { relays: via, target: contact.type === AdvType.Repeater ? key.slice(0, size * 2) : null };
}

async function begin(key: string, mode: Ping["mode"], via: string[] | null): Promise<Ping | null> {
  stopped.delete(key);
  const base: Ping = { key, chain: [], targetInChain: false, via, mode, runs: [], hops: null, running: true, error: null, at: Date.now() };
  publish(base);
  try {
    const path = via ? pathVia(key, via) : await session.pingPath(key);
    if (!path) {
      publish({ ...base, running: false, error: "No route to it is known yet. It shows up with its next advert, or after a message." });
      return null;
    }
    const chain = path.target ? [...path.relays, path.target] : path.relays;
    if (chain.length === 0) {
      publish({ ...base, running: false, error: "Heard direct: there is nobody between you to ping." });
      return null;
    }
    const ping = { ...base, chain, targetInChain: path.target !== null };
    publish(ping);
    return ping;
  } catch (error) {
    publish({ ...base, running: false, error: (error as Error).message });
    return null;
  }
}

/** Five round trips along the route, or along `via`, one after the other. */
export async function ping(key: string, via: string[] | null = null): Promise<void> {
  const p = await begin(key, "rounds", via);
  if (!p) return;
  try {
    for (let i = 0; i < ROUNDS && !stopped.has(key); i++) {
      if (i > 0) await wait(GAP_MS);
      const back = await session.traceRoute(p.chain);
      if (stopped.has(key)) break;
      p.runs = [...p.runs, back ? { ok: true, rttMs: back.rttMs, legs: traceLegs(back.snrs, p.chain.length) } : { ok: false, rttMs: null, legs: [] }];
      publish(p);
    }
  } catch (error) {
    p.error = (error as Error).message;
  }
  p.running = false;
  publish(p);
}

/** One hop further each time, until a hop stays silent twice: that is where the route breaks. */
export async function findBreak(key: string, via: string[] | null = null): Promise<void> {
  const p = await begin(key, "hops", via);
  if (!p) return;
  p.hops = p.chain.map(() => ({ state: "waiting", tries: 0, leg: null }));
  publish(p);
  try {
    for (let k = 0; k < p.chain.length && !stopped.has(key); k++) {
      const hop = p.hops[k]!;
      while (hop.state !== "ok" && hop.state !== "silent" && !stopped.has(key)) {
        hop.state = "trying";
        publish(p);
        const back = await session.traceRoute(p.chain.slice(0, k + 1));
        if (stopped.has(key)) break;
        if (back) {
          hop.state = "ok";
          hop.leg = traceLegs(back.snrs, k + 1)[k] ?? null;
        } else if (++hop.tries >= TRIES) {
          hop.state = "silent";
        }
        publish(p);
        await wait(GAP_MS);
      }
      if (hop.state === "silent") break;
    }
  } catch (error) {
    p.error = (error as Error).message;
  }
  for (const hop of p.hops) if (hop.state === "trying") hop.state = "waiting";
  p.running = false;
  publish(p);
}

export function stopPing(key: string): void {
  stopped.add(key);
  const p = pings.get(key);
  if (p?.running) publish({ ...p, running: false });
}

/** Forgets what was measured, when the route it was measured along has changed. */
export function clearPing(key: string): void {
  stopPing(key);
  pings.delete(key);
  for (const listener of listeners) listener();
}

/** A route being changed was saved as `relays`: what was measured along it is now the route's, and anything else is forgotten. */
export function settlePing(key: string, relays: string[]): void {
  const p = pings.get(key);
  if (p?.via && !p.running && p.via.length === relays.length && p.via.every((h, i) => h === relays[i])) publish({ ...p, via: null });
  else clearPing(key);
}

/** The legs measured last: from the last round that came back, or from the hops checked so far. */
export function measuredLegs(p: Ping | null): (Leg | null)[] {
  if (!p) return [];
  if (p.mode === "hops") return (p.hops ?? []).map((h) => h.leg);
  const last = [...p.runs].reverse().find((r) => r.ok);
  return last ? last.legs : [];
}

/** The weakest leg measured, by its worse direction. */
export function weakestLeg(p: Ping | null): { index: number; snr: number } | null {
  let worst: { index: number; snr: number } | null = null;
  measuredLegs(p).forEach((leg, index) => {
    if (!leg) return;
    const snr = Math.min(leg[0], leg[1]);
    if (!worst || snr < worst.snr) worst = { index, snr };
  });
  return worst;
}
