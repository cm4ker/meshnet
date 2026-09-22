/**
 * What the map draws over the nodes: the route to the node picked, coloured
 * by what a ping measured along it; a route being changed; a line of sight;
 * the repeaters that answered "who hears me". Worked out here from the state,
 * so the map only draws lines and hands their taps and drags back.
 */

import { AdvType, contactRoute, type ContactRecord, type SessionState } from "@meshnet/meshcore";
import { candidatesOfHash } from "./echoes.js";
import { hasPosition } from "./geo.js";
import { legId } from "./legVerdicts.js";
import type { Hears } from "./hears.js";
import { quality } from "./los.js";
import type { LosEnd, MeshTool } from "./meshTool.js";
import { measuredLegs, type Ping } from "./ping.js";

export type LineTone = "good" | "fair" | "weak" | "fail" | "flight" | "plain" | "unknown" | "dest" | "look";

export interface OverlayLine {
  from: LosEnd;
  to: LosEnd;
  tone: LineTone;
  /** Whether a tap on it opens its line of sight: only a leg whose both ends are known. */
  tappable: boolean;
  /** A word at its middle, for a leg the terrain closes. */
  label?: string | undefined;
}

/**
 * A point of a route a finger can drag onto a node: a relay, to put another
 * in its place, or the middle of a leg, to put one in between.
 */
export interface MapHandle {
  /** `hop` is relay `index` of the route; `gap` is where a relay goes in before relay `index`. */
  kind: "hop" | "gap";
  index: number;
  lat: number;
  lon: number;
  /** The drawn ends either side, joined to the finger while it drags. */
  from: LosEnd | null;
  to: LosEnd | null;
  /** The relay's contact, which a tap on the hop picks. */
  key: string | null;
}

export interface MapOverlay {
  lines: OverlayLine[];
  /** A spot picked on the map. */
  pins: { lat: number; lon: number }[];
  /** Relays of a route being changed, by contact key, numbered in order. */
  numbers: Record<string, number>;
  handles: MapHandle[];
}

export const EMPTY_OVERLAY: MapOverlay = { lines: [], pins: [], numbers: {}, handles: [] };

export function selfEnd(state: SessionState): LosEnd | null {
  const self = state.self;
  return self && hasPosition(self.lat, self.lon) ? { lat: self.lat, lon: self.lon, name: "You", key: "self" } : null;
}

export function contactEnd(c: ContactRecord): LosEnd | null {
  return hasPosition(c.lat, c.lon) ? { lat: c.lat, lon: c.lon, name: c.name || c.prefix, key: c.key } : null;
}

/** The contact a hash names, when exactly one relaying contact does and its position is known. */
export function relayOf(hash: string, contacts: Record<string, ContactRecord>): ContactRecord | null {
  const found = candidatesOfHash(hash, contacts);
  return found.length === 1 ? found[0]! : null;
}

/** An antenna's height, m, for a line of sight when nobody has said: a person's hand, a repeater's mast, a mast yet to be put up. */
export function defaultHeight(end: LosEnd, contacts: Record<string, ContactRecord>): number {
  if (end.key === "self") return 1.5;
  if (end.key === null) return 10;
  const type = contacts[end.key]?.type;
  return type === AdvType.Repeater || type === AdvType.Room ? 10 : 1.5;
}

/**
 * The relays of the route drawn to a contact, as hashes: the ones pinged
 * last, which for a repeater with no route are the way its adverts came, or
 * else the route the radio holds. Null when there is neither.
 */
export function shownRelays(contact: ContactRecord, ping: Ping | null): string[] | null {
  if (ping && ping.chain.length && !ping.via) return ping.targetInChain ? ping.chain.slice(0, -1) : ping.chain;
  return contactRoute(contact);
}

/** Whether a chain of relays as hashes is the one given as contact keys or hashes. */
export function sameRelays(hashes: string[], relays: string[]): boolean {
  return hashes.length === relays.length && hashes.every((h, i) => relays[i]!.startsWith(h) || h.startsWith(relays[i]!));
}

/**
 * The lines through a chain of nodes, this radio first and the contact
 * last, and a handle on every relay and in the middle of every leg. A node
 * with no place on the map is skipped: the line goes round it, and the leg
 * cannot be tapped for its line of sight.
 */
function chainOverlay(nodes: (LosEnd | null)[], toneOf: (leg: number) => LineTone, label: (a: LosEnd, b: LosEnd) => string | undefined, handles: boolean): MapOverlay {
  const worse = (a: LineTone, b: LineTone): LineTone => {
    const order: LineTone[] = ["fail", "weak", "fair", "good", "flight", "dest", "unknown", "plain"];
    return order.indexOf(a) <= order.indexOf(b) ? a : b;
  };
  const lines: OverlayLine[] = [];
  const gaps: MapHandle[] = [];
  let from = nodes[0] ?? null;
  let first = 0;
  for (let i = 1; i < nodes.length; i++) {
    const to = nodes[i];
    if (!to) continue;
    if (from) {
      let tone = toneOf(first);
      for (let j = first + 1; j < i; j++) tone = worse(tone, toneOf(j));
      lines.push({ from, to, tone, tappable: i - first === 1, label: label(from, to) });
      gaps.push({ kind: "gap", index: first, lat: (from.lat + to.lat) / 2, lon: (from.lon + to.lon) / 2, from, to, key: null });
    }
    from = to;
    first = i;
  }
  const drawn = (i: number, step: number): LosEnd | null => {
    for (let j = i + step; j >= 0 && j < nodes.length; j += step) if (nodes[j]) return nodes[j]!;
    return null;
  };
  const hops: MapHandle[] = [];
  for (let i = 1; i < nodes.length - 1; i++) {
    const at = nodes[i];
    if (at) hops.push({ kind: "hop", index: i - 1, lat: at.lat, lon: at.lon, from: drawn(i, -1), to: drawn(i, 1), key: at.key });
  }
  return { lines, pins: [], numbers: {}, handles: handles ? [...gaps, ...hops] : [] };
}

/** The tone of each leg of a chain, from what a ping measured along it. */
function pingTone(ping: Ping | null, legs: number, toPerson: boolean): (i: number) => LineTone {
  const measured = measuredLegs(ping);
  return (i) => {
    if (i === legs - 1 && toPerson) return "dest";
    if (ping?.running && ping.mode === "rounds") return "flight";
    const hop = ping?.mode === "hops" ? ping.hops?.[i] : undefined;
    if (hop?.state === "trying") return "flight";
    if (hop?.state === "silent") return "fail";
    const leg = measured[i];
    return leg ? quality(Math.min(leg[0], leg[1])) : "plain";
  };
}

/**
 * The legs of the route to a contact, this radio first: each leg's ends, and
 * how it sounded when last pinged. A relay whose hash names nobody for sure,
 * or nobody with a position, cannot be drawn; the line then skips it and the
 * leg around it cannot be tapped. Its relays and legs can be dragged, but
 * not while a ping is on its way along them.
 */
export function routeOverlay(key: string, state: SessionState, ping: Ping | null): MapOverlay {
  const contact = state.contacts[key];
  if (!contact) return EMPTY_OVERLAY;
  const target = contactEnd(contact);
  const relays = shownRelays(contact, ping);
  if (relays === null || !target) return EMPTY_OVERLAY;
  const nodes: (LosEnd | null)[] = [selfEnd(state), ...relays.map((h) => { const r = relayOf(h, state.contacts); return r ? contactEnd(r) : null; }), target];
  const measured = ping?.via ? null : ping;
  return chainOverlay(nodes, pingTone(measured, nodes.length - 1, contact.type !== AdvType.Repeater), () => undefined, !ping?.running);
}

/**
 * A route being changed: this radio, the relays tapped or dragged so far,
 * the contact it leads to; coloured once it is pinged as it stands. Every
 * leg opens its line of sight, even one that goes round a node off the map.
 */
export function editOverlay(tool: Extract<MeshTool, { kind: "route" }>, state: SessionState, blocked: Set<string>, ping: Ping | null): MapOverlay {
  const target = state.contacts[tool.key];
  const ends = [selfEnd(state), ...tool.relays.map((k) => { const r = state.contacts[k] ?? relayOf(k, state.contacts); return r ? contactEnd(r) : null; }), target ? contactEnd(target) : null];
  const toPerson = target?.type !== AdvType.Repeater;
  const pinged = ping?.via && sameRelays(ping.via, tool.relays) ? ping : null;
  const measured = pingTone(pinged, ends.length - 1, toPerson);
  const tone = (i: number): LineTone => (pinged ? measured(i) : i === ends.length - 2 && toPerson ? "dest" : "unknown");
  const overlay = chainOverlay(ends, tone, (a, b) => (blocked.has(legId(a, b)) ? "blocked" : undefined), !pinged?.running);
  const numbers: Record<string, number> = {};
  tool.relays.forEach((k, i) => (numbers[k] = i + 1));
  return { ...overlay, lines: overlay.lines.map((l) => ({ ...l, tappable: true })), numbers };
}

export function losOverlay(tool: Extract<MeshTool, { kind: "los" }>): MapOverlay {
  return { lines: [{ from: tool.from, to: tool.to, tone: "look", tappable: false }], pins: tool.to.key === null ? [{ lat: tool.to.lat, lon: tool.to.lon }] : [], numbers: {}, handles: [] };
}

/** A line from this radio to each repeater that answered, coloured by how well it heard us. */
export function hearsOverlay(hears: Hears, state: SessionState): MapOverlay {
  const me = selfEnd(state);
  if (!me) return EMPTY_OVERLAY;
  const lines: OverlayLine[] = [];
  for (const reply of hears.replies) {
    const c = state.contacts[reply.key];
    const end = c ? contactEnd(c) : null;
    if (end) lines.push({ from: me, to: end, tone: quality(reply.heardUs), tappable: true });
  }
  return { lines, pins: [], numbers: {}, handles: [] };
}
