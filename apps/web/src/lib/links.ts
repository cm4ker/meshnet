/**
 * The link book of the radio connected (lib/linkGraph.ts): what it has heard
 * of who hears whom. Filled from every flooded packet the radio hands up,
 * from every trace and from "who hears me", and kept on disk for a week, one
 * book per radio. Listening starts with the app; nothing here transmits.
 */

import { PayloadType, toHex, type HeardPacket } from "@meshnet/meshcore";
import { bookFromJson, bookToJson, noteFlood, noteLeg, noteLost, prune, SELF, tracedLegs, type LinkBook } from "./linkGraph.js";
import { session, storage } from "./session.js";

const SAVE_EVERY_MS = 30_000;

let book: LinkBook = new Map();
let radio: string | null = null;
let dirty = false;

/** The book of the radio connected; empty while none is. */
export function linkBook(): LinkBook {
  return book;
}

function heard(h: HeardPacket): void {
  const p = h.packet;
  // A trace's path holds SNRs, not hashes; a direct packet's holds the hops still to go.
  if (!p || !p.flood || p.payloadType === PayloadType.Trace) return;
  const sender = p.payloadType === PayloadType.Advert && p.payload.length >= 32 ? toHex(p.payload.subarray(0, 32)) : null;
  if (p.path.length === 0 && !sender) return;
  noteFlood(book, p.path, h.snr, sender && sender === radio ? SELF : sender, h.at);
  dirty = true;
}

/** A trace that came back, out through `hops` and home: every leg it went along, as it sounded. */
export function noteTrace(hops: string[], snrs: number[]): void {
  const at = Date.now();
  for (const leg of tracedLegs(hops, snrs)) noteLeg(book, leg.from, leg.to, leg.snr, at);
  dirty = true;
}

/** A leg a trace was lost on, between two hashes (or `SELF`). */
export function noteBreak(a: string, b: string): void {
  noteLost(book, a, b, Date.now());
  dirty = true;
}

/** A repeater that answered "who hears me": how it heard us, and how we heard it. */
export function noteHeardUs(hash: string, heardUs: number, heardThem: number): void {
  const at = Date.now();
  noteLeg(book, SELF, hash, heardUs, at);
  noteLeg(book, hash, SELF, heardThem, at);
  dirty = true;
}

async function save(key: string | null, what: LinkBook): Promise<void> {
  if (!key || !dirty) return;
  dirty = false;
  prune(what, Date.now());
  try {
    await storage.saveExtra(`links:${key}`, bookToJson(what));
  } catch {
    dirty = true;
  }
}

async function load(key: string): Promise<void> {
  try {
    const loaded = bookFromJson(await storage.loadExtra(`links:${key}`));
    if (radio !== key) return;
    // What was heard while it loaded is newer than what was kept.
    for (const [id, link] of book) loaded.set(id, link);
    prune(loaded, Date.now());
    book = loaded;
  } catch {
    // A book that cannot be read starts again from what the radio hears.
  }
}

/** Listens from now on, and keeps each radio's book as it changes. */
export function startLinks(): void {
  session.onHeard(heard);
  session.subscribe(() => {
    const key = session.getState().self?.key ?? null;
    if (key === radio) return;
    void save(radio, book);
    // What was heard before the radio said who it is was heard through it.
    const carried = radio === null ? book : new Map();
    radio = key;
    book = key ? carried : new Map();
    dirty = book.size > 0;
    if (key) void load(key);
  });
  setInterval(() => void save(radio, book), SAVE_EVERY_MS);
  globalThis.addEventListener?.("pagehide", () => void save(radio, book));
}
