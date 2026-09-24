/**
 * Who hears whom on the mesh, as far as this radio can tell, and the ways
 * through it. Every flooded packet the radio hands up names the repeaters it
 * went through, in order, and each one heard the one before it: so each pair
 * in its path is a link that worked, one way, and the last is a link to this
 * radio, heard at the packet's SNR. A trace adds how well each leg it went
 * along sounded, and a trace that died leaves a mark on the leg it died on.
 * Neighbour lists and the routes the radio holds count too, read from the
 * session as they are.
 *
 * Nothing here goes on the air. It is what a search for a way looks through
 * first, so the air is asked only to confirm a way, one trace at a time.
 * Pure: the book is handed in, and the clock with it.
 */

import { AdvType, contactRoute, type ContactRecord, type SessionState } from "@meshnet/meshcore";

/** This radio, as an end of a link. */
export const SELF = "self";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Links nobody has heard of for this long are forgotten. */
export const KEEP_MS = 7 * DAY;
/** A book past this many links drops the stalest. */
const MAX_LINKS = 6000;

/** One direction of a link: `to` heard `from`. An end is a hash as it was heard, a whole key, or `SELF`. */
export interface Link {
  from: string;
  to: string;
  /** Times it was seen in the path of a flooded packet. */
  seen: number;
  /** When it was last seen so, local ms; 0 for never. */
  seenAt: number;
  /** How well `to` heard `from` when last measured, dB, and when. */
  snr: number | null;
  snrAt: number;
  /** When a trace was last lost on it, as near as could be told; 0 for never. */
  lostAt: number;
}

export type LinkBook = Map<string, Link>;

export function linkId(from: string, to: string): string {
  return `${from}>${to}`;
}

function entry(book: LinkBook, from: string, to: string): Link {
  const id = linkId(from, to);
  let link = book.get(id);
  if (!link) {
    link = { from, to, seen: 0, seenAt: 0, snr: null, snrAt: 0, lostAt: 0 };
    book.set(id, link);
  }
  return link;
}

/**
 * A flooded packet heard at `snr`: its path, first relay first, and the node
 * it came from when the packet says (an advert carries its sender's key).
 */
export function noteFlood(book: LinkBook, path: string[], snr: number, origin: string | null, at: number): void {
  const chain = origin ? [origin, ...path] : path;
  if (chain.length === 0) return;
  for (let i = 0; i < chain.length - 1; i++) {
    if (chain[i] === chain[i + 1]) continue;
    const link = entry(book, chain[i]!, chain[i + 1]!);
    link.seen++;
    link.seenAt = Math.max(link.seenAt, at);
  }
  const last = entry(book, chain[chain.length - 1]!, SELF);
  last.seen++;
  last.seenAt = Math.max(last.seenAt, at);
  last.snr = snr;
  last.snrAt = at;
}

/** A leg a trace went along: `to` heard `from` at `snr`. */
export function noteLeg(book: LinkBook, from: string, to: string, snr: number, at: number): void {
  if (from === to) return;
  const link = entry(book, from, to);
  link.snr = snr;
  link.snrAt = at;
}

/** A leg a trace was lost on. Which way it failed is not known, so both are marked. */
export function noteLost(book: LinkBook, a: string, b: string, at: number): void {
  if (a === b) return;
  entry(book, a, b).lostAt = at;
  entry(book, b, a).lostAt = at;
}

/**
 * The legs of a trace that came back, in order: `hops` the hashes it went
 * through, and `snrs` what each heard the one before it at, ours last.
 */
export function tracedLegs(hops: string[], snrs: number[]): { from: string; to: string; snr: number }[] {
  const nodes = [SELF, ...hops, SELF];
  const legs: { from: string; to: string; snr: number }[] = [];
  for (let i = 0; i < nodes.length - 1 && i < snrs.length; i++) legs.push({ from: nodes[i]!, to: nodes[i + 1]!, snr: snrs[i]! });
  return legs;
}

/** Drops what is too old to count, and the stalest past the cap. */
export function prune(book: LinkBook, now: number): void {
  const last = (l: Link) => Math.max(l.seenAt, l.snrAt, l.lostAt);
  for (const [id, link] of book) if (last(link) < now - KEEP_MS) book.delete(id);
  if (book.size <= MAX_LINKS) return;
  const byAge = [...book.entries()].sort((a, b) => last(a[1]) - last(b[1]));
  for (const [id] of byAge.slice(0, book.size - MAX_LINKS)) book.delete(id);
}

// ---- the graph ----

/** The chance a trace gets through a hop heard at `snr`. */
export function snrChance(snr: number): number {
  return Math.min(0.97, Math.max(0.05, 1 / (1 + Math.exp(-(snr + 7) / 1.6))));
}

function fade(age: number): number {
  return age < 6 * HOUR ? 1 : age < DAY ? 0.85 : age < 3 * DAY ? 0.7 : 0.55;
}

/** How likely a trace gets along a link, from what the book says of it. */
export function linkChance(link: Link, now: number): number {
  const bySnr = link.snr !== null ? snrChance(link.snr) * fade(now - link.snrAt) : null;
  const bySeen = link.seen > 0 ? (link.seen >= 3 ? 0.8 : 0.7) * fade(now - link.seenAt) : null;
  // A measurement newer than the last sighting says more than the sighting did.
  let p = bySnr === null ? (bySeen ?? 0) : bySeen === null || link.snrAt >= link.seenAt ? bySnr : Math.max(bySnr, bySeen);
  if (link.lostAt) {
    const since = now - link.lostAt;
    const newer = link.lostAt >= Math.max(link.snrAt, link.seenAt);
    if (newer && since < HOUR) p *= 0.08;
    else if (newer && since < 6 * HOUR) p *= 0.4;
  }
  return p;
}

export interface Graph {
  /** From → to → chance a trace gets through. */
  edges: Map<string, Map<string, number>>;
  /** Nodes that pass a trace on: repeaters, and hashes naming nobody for sure. */
  relays: Set<string>;
}

/** Hashes that name more than one repeater, or none on the radio, are kept as themselves, marked so. */
export function unresolved(hash: string): string {
  return `#${hash}`;
}

export function isUnresolved(node: string): boolean {
  return node.startsWith("#");
}

/**
 * Who an end of a link is: this radio; a contact, when the key or hash names
 * exactly one (a repeater, for a hash, since only they relay); else the hash.
 */
export function resolver(contacts: Record<string, ContactRecord>): (end: string) => string {
  const all = Object.values(contacts);
  const cache = new Map<string, string>();
  return (end) => {
    if (end === SELF) return SELF;
    let node = cache.get(end);
    if (node !== undefined) return node;
    const matches = all.filter((c) => c.key.startsWith(end));
    const repeaters = matches.filter((c) => c.type === AdvType.Repeater);
    if (end.length >= 64) node = matches[0]?.key ?? end;
    else if (repeaters.length === 1) node = repeaters[0]!.key;
    else if (repeaters.length === 0 && matches.length === 1) node = matches[0]!.key;
    else node = unresolved(end);
    cache.set(end, node);
    return node;
  };
}

/**
 * The graph a search goes through: every link the book knows and the
 * session shows, each pair of nodes once, at the best chance any of them
 * gives it. A link known one way only is guessed the other way, lower.
 */
export function buildGraph(book: LinkBook, state: Pick<SessionState, "contacts" | "neighbours">, now: number): Graph {
  const resolve = resolver(state.contacts);
  const edges = new Map<string, Map<string, number>>();
  const relays = new Set<string>();
  const put = (from: string, to: string, p: number) => {
    if (from === to || p <= 0) return;
    let out = edges.get(from);
    if (!out) edges.set(from, (out = new Map()));
    out.set(to, Math.max(out.get(to) ?? 0, p));
  };
  const lost = new Map<string, number>();
  for (const link of book.values()) {
    const from = resolve(link.from);
    const to = resolve(link.to);
    const p = linkChance(link, now);
    if (p > 0) put(from, to, p);
    // A loss marks the pair however the other evidence adds up.
    if (link.lostAt) lost.set(linkId(from, to), Math.max(lost.get(linkId(from, to)) ?? 0, link.lostAt));
  }
  for (const [key, list] of Object.entries(state.neighbours ?? {})) {
    for (const n of list.neighbours) put(resolve(n.prefix), key, snrChance(n.snr) * fade(now - list.at + n.heardSecsAgo * 1000));
  }
  // The routes the radio holds worked once, in both directions as far as anyone knows.
  for (const c of Object.values(state.contacts)) {
    const route = contactRoute(c);
    if (!route || route.length === 0) continue;
    const nodes = [SELF, ...route.map(resolve), c.key];
    for (let i = 0; i < nodes.length - 1; i++) {
      put(nodes[i]!, nodes[i + 1]!, 0.5);
      put(nodes[i + 1]!, nodes[i]!, 0.5);
    }
  }
  // The other way round a link heard one way, at less than it.
  for (const [from, out] of [...edges]) {
    for (const [to, p] of out) {
      if (!edges.get(to)?.has(from)) put(to, from, Math.min(0.6, p * 0.7));
    }
  }
  for (const [id, at] of lost) {
    const [from, to] = id.split(">") as [string, string];
    const since = now - at;
    const out = edges.get(from);
    if (out?.has(to) && since < HOUR) out.set(to, Math.min(out.get(to)!, 0.08));
  }
  for (const node of new Set([...edges.keys(), ...[...edges.values()].flatMap((m) => [...m.keys()])])) {
    if (isUnresolved(node) || state.contacts[node]?.type === AdvType.Repeater) relays.add(node);
  }
  return { edges, relays };
}

const HOP_COST = 0.12;
const UNSURE_COST = 0.45;

export interface WayOptions {
  /** Links not to use at all. */
  avoid?: Set<string>;
  /** Links to count a little cheaper. */
  prefer?: Set<string>;
  /** Links to count as this much less likely than the book says: suspects of a way that stayed silent. */
  doubt?: Map<string, number>;
  maxHops?: number;
}

/**
 * The likeliest way from `from` to `to`, both included, through relays only.
 * Null when there is none within `maxHops`.
 */
export function findWay(g: Graph, from: string, to: string, opts: WayOptions = {}): string[] | null {
  const maxHops = opts.maxHops ?? 16;
  const dist = new Map<string, number>([[from, 0]]);
  const hops = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, string>();
  const done = new Set<string>();
  for (;;) {
    let at: string | null = null;
    let best = Infinity;
    for (const [node, d] of dist) {
      if (!done.has(node) && d < best) {
        best = d;
        at = node;
      }
    }
    if (at === null) return null;
    if (at === to) break;
    done.add(at);
    // Only a relay passes it on; the ends need not be one.
    if (at !== from && !g.relays.has(at)) continue;
    const h = hops.get(at)!;
    if (h >= maxHops) continue;
    for (const [next, p] of g.edges.get(at) ?? []) {
      if (done.has(next) || (next === SELF && to !== SELF)) continue;
      const id = linkId(at, next);
      if (opts.avoid?.has(id)) continue;
      let cost = -Math.log(p * (opts.doubt?.get(id) ?? 1)) + HOP_COST + (isUnresolved(next) ? UNSURE_COST : 0);
      if (opts.prefer?.has(id)) cost *= 0.8;
      const d = best + cost;
      if (d < (dist.get(next) ?? Infinity)) {
        dist.set(next, d);
        hops.set(next, h + 1);
        prev.set(next, at);
      }
    }
  }
  const way = [to];
  while (way[0] !== from) way.unshift(prev.get(way[0]!)!);
  return way;
}

/** The chance of getting along every leg of a way. */
export function wayChance(g: Graph, way: string[]): number {
  let p = 1;
  for (let i = 0; i < way.length - 1; i++) p *= g.edges.get(way[i]!)?.get(way[i + 1]!) ?? 0;
  return p;
}

/** The links along a way, in order, as link ids. */
export function wayLinks(way: string[]): string[] {
  const ids: string[] = [];
  for (let i = 0; i < way.length - 1; i++) if (way[i] !== way[i + 1]) ids.push(linkId(way[i]!, way[i + 1]!));
  return ids;
}

export interface PlannedWay {
  /** The nodes a trace goes out through, in order: the relays, then the target when it relays too. */
  out: string[];
  /** The nodes it comes home through from the last of `out`, nearest to it first; null for the same way back. */
  back: string[] | null;
}

/**
 * A way to trace to `target` and home: out the likeliest way there, and
 * home the likeliest way back, which is the same way unless the book knows
 * that way to be worse going home. A target that is no repeater is reached
 * through the relay nearest it: the trace turns there.
 */
export function planWay(g: Graph, target: string, targetRelays: boolean, avoid: Set<string> = new Set(), doubt?: Map<string, number>): PlannedWay | null {
  const there = findWay(g, SELF, target, { avoid, ...(doubt ? { doubt } : {}) });
  if (!there) return null;
  const out = targetRelays ? there.slice(1) : there.slice(1, -1);
  if (out.length === 0) return null;
  const turn = out[out.length - 1]!;
  const mirror = [turn, ...out.slice(0, -1).reverse(), SELF];
  const prefer = new Set<string>();
  for (let i = 0; i < mirror.length - 1; i++) prefer.add(linkId(mirror[i]!, mirror[i + 1]!));
  const home = findWay(g, turn, SELF, { avoid, prefer, ...(doubt ? { doubt } : {}) });
  if (!home) return { out, back: null };
  const same = home.length === mirror.length && home.every((n, i) => n === mirror[i]);
  return { out, back: same ? null : home.slice(1, -1) };
}

/**
 * The first leg along a chain that does not answer. `probe(m)` traces out
 * to the m-th node and back; leg i ends at node i (0-based), and the whole
 * chain of `n` is known not to answer. Halves the chain each time, so seven
 * nodes take three probes, not seven.
 */
export async function locateBreak(n: number, probe: (m: number) => Promise<boolean>): Promise<number> {
  let lo = 0;
  let hi = n;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (await probe(m)) lo = m;
    else hi = m;
  }
  return lo;
}

// ---- keeping it ----

export function bookToJson(book: LinkBook): Link[] {
  return [...book.values()];
}

export function bookFromJson(value: unknown): LinkBook {
  const book: LinkBook = new Map();
  if (!Array.isArray(value)) return book;
  for (const raw of value as Partial<Link>[]) {
    if (typeof raw?.from !== "string" || typeof raw.to !== "string") continue;
    book.set(linkId(raw.from, raw.to), {
      from: raw.from,
      to: raw.to,
      seen: Number(raw.seen) || 0,
      seenAt: Number(raw.seenAt) || 0,
      snr: typeof raw.snr === "number" ? raw.snr : null,
      snrAt: Number(raw.snrAt) || 0,
      lostAt: Number(raw.lostAt) || 0,
    });
  }
  return book;
}
