/**
 * What the map draws over the nodes: the route to the node picked, coloured
 * by what a ping measured along it; a route being changed; a line of sight;
 * the repeaters that answered "who hears me". Worked out here from the state,
 * so the map only draws lines and hands their taps back.
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

export interface MapOverlay {
  lines: OverlayLine[];
  /** A spot picked on the map. */
  pins: { lat: number; lon: number }[];
  /** Relays of a route being changed, by contact key, numbered in order. */
  numbers: Record<string, number>;
}

export const EMPTY_OVERLAY: MapOverlay = { lines: [], pins: [], numbers: {} };

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
 * The legs of the route to a contact, this radio first: each leg's ends, and
 * how it sounded when last pinged. A relay whose hash names nobody for sure,
 * or nobody with a position, cannot be drawn; the line then skips it and the
 * leg around it cannot be tapped.
 */
export function routeOverlay(key: string, state: SessionState, ping: Ping | null): MapOverlay {
  const contact = state.contacts[key];
  if (!contact) return EMPTY_OVERLAY;
  const target = contactEnd(contact);
  // The route pinged may be the adverts' way in rather than one the radio holds; the ping knows.
  const relays = ping && ping.chain.length ? (ping.targetInChain ? ping.chain.slice(0, -1) : ping.chain) : contactRoute(contact);
  if (relays === null || !target) return EMPTY_OVERLAY;
  const nodes: (LosEnd | null)[] = [selfEnd(state), ...relays.map((h) => { const r = relayOf(h, state.contacts); return r ? contactEnd(r) : null; }), target];
  const legs = measuredLegs(ping);
  const toneOf = (i: number): LineTone => {
    if (i === nodes.length - 2 && contact.type !== AdvType.Repeater) return "dest";
    if (ping?.running && ping.mode === "rounds") return "flight";
    const hop = ping?.mode === "hops" ? ping.hops?.[i] : undefined;
    if (hop?.state === "trying") return "flight";
    if (hop?.state === "silent") return "fail";
    const leg = legs[i];
    return leg ? quality(Math.min(leg[0], leg[1])) : "plain";
  };
  const worse = (a: LineTone, b: LineTone): LineTone => {
    const order: LineTone[] = ["fail", "weak", "fair", "good", "flight", "dest", "plain"];
    return order.indexOf(a) <= order.indexOf(b) ? a : b;
  };
  const lines: OverlayLine[] = [];
  let from = nodes[0] ?? null;
  let first = 0;
  for (let i = 1; i < nodes.length; i++) {
    const to = nodes[i];
    if (!to) continue;
    if (from) {
      let tone = toneOf(first);
      for (let j = first + 1; j < i; j++) tone = worse(tone, toneOf(j));
      lines.push({ from, to, tone, tappable: i - first === 1 });
    }
    from = to;
    first = i;
  }
  return { lines, pins: [], numbers: {} };
}

/** A route being changed: this radio, the relays tapped so far, the contact it leads to. */
export function editOverlay(tool: Extract<MeshTool, { kind: "route" }>, state: SessionState, blocked: Set<string>): MapOverlay {
  const target = state.contacts[tool.key];
  const ends = [selfEnd(state), ...tool.relays.map((k) => (state.contacts[k] ? contactEnd(state.contacts[k]) : null)), target ? contactEnd(target) : null];
  const lines: OverlayLine[] = [];
  for (let i = 0; i < ends.length - 1; i++) {
    const a = ends[i];
    const b = ends[i + 1];
    if (!a || !b) continue;
    const closed = blocked.has(legId(a, b));
    lines.push({ from: a, to: b, tone: i === ends.length - 2 && target?.type !== AdvType.Repeater ? "dest" : "unknown", tappable: true, label: closed ? "blocked" : undefined });
  }
  const numbers: Record<string, number> = {};
  tool.relays.forEach((k, i) => (numbers[k] = i + 1));
  return { lines, pins: [], numbers };
}

export function losOverlay(tool: Extract<MeshTool, { kind: "los" }>): MapOverlay {
  return { lines: [{ from: tool.from, to: tool.to, tone: "look", tappable: false }], pins: tool.to.key === null ? [{ lat: tool.to.lat, lon: tool.to.lon }] : [], numbers: {} };
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
  return { lines, pins: [], numbers: {} };
}
