/**
 * A repeater's neighbour list read for the map: each neighbour matched to
 * the contact its prefix names, how long ago it was heard as of now, and
 * whether that is so long ago it may be gone. The repeater keeps a
 * neighbour until its table fills, however long ago it last heard it.
 */

import type { ContactRecord, NeighbourList, SessionState } from "@meshnet/meshcore";
import { hasPosition } from "./geo.js";

/** Heard longer ago than this, s, a neighbour is drawn faint: it may have gone. */
export const STALE_S = 86_400;

/** How many a request brings back: the page in the node's screens asks for as many. */
export const PAGE = 10;

export interface NeighbourRow {
  prefix: string;
  snr: number;
  /** Seconds since the repeater last heard it, as of now rather than of the answer. */
  heardS: number;
  contact: ContactRecord | null;
  /** Whether the contact has a position, so a line can be drawn to it. */
  placed: boolean;
  stale: boolean;
}

/** The contact a neighbour's prefix names, if one does. */
export function contactOfPrefix(contacts: Record<string, ContactRecord>, prefix: string): ContactRecord | null {
  if (!prefix) return null;
  for (const c of Object.values(contacts)) if (c.key.startsWith(prefix)) return c;
  return null;
}

/** The neighbours of `key` fetched so far, strongest first. */
export function neighbourRows(state: Pick<SessionState, "contacts" | "neighbours">, key: string, now: number): NeighbourRow[] {
  const list = state.neighbours[key];
  if (!list) return [];
  const since = Math.max(0, (now - list.at) / 1000);
  return list.neighbours
    .map((n) => {
      const contact = contactOfPrefix(state.contacts, n.prefix);
      const heardS = n.heardSecsAgo + since;
      return { prefix: n.prefix, snr: n.snr, heardS, contact, placed: !!contact && hasPosition(contact.lat, contact.lon), stale: heardS > STALE_S };
    })
    .sort((a, b) => b.snr - a.snr);
}

/** Whether the list holds all the repeater said it has. */
export function isComplete(list: NeighbourList | undefined): boolean {
  return !!list && list.neighbours.length >= list.total;
}

/** How `from` hears `to`, from `from`'s own list, when it has been read and names `to`. */
export function heardInList(state: Pick<SessionState, "neighbours">, from: string, to: string, now: number): { snr: number; heardS: number } | null {
  const list = state.neighbours[from];
  const n = list?.neighbours.find((r) => r.prefix && to.startsWith(r.prefix));
  return list && n ? { snr: n.snr, heardS: n.heardSecsAgo + Math.max(0, (now - list.at) / 1000) } : null;
}
