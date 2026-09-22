/**
 * "Who hears me": one zero-hop packet, and the repeaters in direct range
 * answer how well they heard it. A repeater answers no more than four times
 * in two minutes, so the asks are counted here and the button waits rather
 * than spend airtime on answers that will not come.
 */

import { useSyncExternalStore } from "react";
import type { DiscoverReply } from "@meshnet/meshcore";
import { session } from "./session.js";

export const LISTEN_MS = 10_000;
const LIMIT = 4;
const WINDOW_MS = 120_000;

export interface Hears {
  listening: boolean;
  startedAt: number | null;
  replies: DiscoverReply[];
  asks: number[];
  error: string | null;
}

let state: Hears = { listening: false, startedAt: null, replies: [], asks: [], error: null };
const listeners = new Set<() => void>();

function set(patch: Partial<Hears>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function useHears(): Hears {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

/** Asks left before the repeaters stop answering, and when the next one comes back. */
export function asksLeft(now = Date.now()): { left: number; nextAt: number | null } {
  const recent = state.asks.filter((t) => now - t < WINDOW_MS);
  return { left: LIMIT - recent.length, nextAt: recent.length >= LIMIT ? recent[0]! + WINDOW_MS : null };
}

export async function askWhoHears(): Promise<void> {
  if (state.listening || asksLeft().left <= 0) return;
  const now = Date.now();
  set({ listening: true, startedAt: now, replies: [], asks: [...state.asks.filter((t) => now - t < WINDOW_MS), now], error: null });
  try {
    const replies = await session.discoverRepeaters(LISTEN_MS, (reply) => set({ replies: [...state.replies.filter((r) => r.key !== reply.key), reply] }));
    set({ replies });
  } catch (error) {
    set({ error: (error as Error).message });
  } finally {
    set({ listening: false });
  }
}
