import { test } from "node:test";
import assert from "node:assert/strict";
import { AdvType, type ContactRecord } from "@meshnet/meshcore";
import {
  bookFromJson,
  bookToJson,
  buildGraph,
  findWay,
  linkChance,
  linkId,
  locateBreak,
  noteFlood,
  noteLeg,
  noteLost,
  planWay,
  resolver,
  SELF,
  tracedLegs,
  unresolved,
  type LinkBook,
} from "./linkGraph.js";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

function contact(first: string, name: string, type: number = AdvType.Repeater): ContactRecord {
  const key = (first + "00".repeat(32)).slice(0, 64);
  return { key, prefix: key.slice(0, 12), type, flags: 0, outPathLen: 0xff, outPath: "", name, lastAdvert: 0, lat: 0, lon: 0, lastMod: 0, lastHeardAt: null, pathSince: null };
}

const K10 = contact("10", "K10");
const MIR = contact("21", "MIR");
const WAN = contact("37", "Wan7");
const SKK = contact("45", "SKK");
const MRK = contact("58", "Marksa");
const AMUR = contact("62", "AMUR-21");
const RMK = contact("f1", "RMK-3");
const KOLYA = contact("aa", "Kolya", AdvType.Chat);
const ALL = [K10, MIR, WAN, SKK, MRK, AMUR, RMK, KOLYA];
const contacts = Object.fromEntries(ALL.map((c) => [c.key, c]));
const state = { contacts, neighbours: {} };
const h = (c: ContactRecord) => c.key.slice(0, 2);

/** Floods heard along the way RMK-3 › AMUR-21 › Marksa › SKK › Wan7 › MIR › K10 › us, and the shortcut Marksa › MIR. */
function city(): LinkBook {
  const book: LinkBook = new Map();
  for (let i = 0; i < 3; i++) {
    noteFlood(book, [h(RMK), h(AMUR), h(MRK), h(SKK), h(WAN), h(MIR), h(K10)], 8, null, NOW - HOUR);
    noteFlood(book, [h(MRK), h(MIR), h(K10)], 9, null, NOW - HOUR);
  }
  return book;
}

test("a flooded path is a chain of links, each heard by the next, the last by us at the packet's SNR", () => {
  const book: LinkBook = new Map();
  noteFlood(book, ["3f", "a1"], -4.5, null, NOW);
  assert.deepEqual([...book.keys()], ["3f>a1", "a1>self"]);
  assert.equal(book.get("a1>self")!.snr, -4.5);
  assert.equal(book.get("3f>a1")!.snr, null);
  // An advert says who sent it: that node was heard by the first relay.
  noteFlood(book, ["3f"], 2, KOLYA.key, NOW);
  assert.ok(book.has(linkId(KOLYA.key, "3f")));
  assert.equal(book.get("3f>self")!.snr, 2);
});

test("a hash names the one repeater it can be; two, or none, leave it a hash", () => {
  const twin = contact("58ff", "Marksa twin");
  const resolve = resolver({ ...contacts, [twin.key]: twin });
  assert.equal(resolve("10"), K10.key);
  assert.equal(resolve("58"), unresolved("58"));
  assert.equal(resolve("99"), unresolved("99"));
  assert.equal(resolve(SELF), SELF);
});

test("the likeliest way goes by links heard often, and round one to avoid", () => {
  const g = buildGraph(city(), state, NOW);
  assert.deepEqual(findWay(g, SELF, RMK.key), [SELF, K10.key, MIR.key, MRK.key, AMUR.key, RMK.key]);
  const long = findWay(g, SELF, RMK.key, { avoid: new Set([linkId(MIR.key, MRK.key)]) });
  assert.deepEqual(long, [SELF, K10.key, MIR.key, WAN.key, SKK.key, MRK.key, AMUR.key, RMK.key]);
  assert.equal(findWay(g, SELF, RMK.key, { avoid: new Set([linkId(K10.key, MIR.key)]) }), null);
});

test("a trace lost on a leg keeps searches off it for a while", () => {
  const book = city();
  noteLost(book, MIR.key.slice(0, 2), MRK.key.slice(0, 2), NOW - 60_000);
  const g = buildGraph(book, state, NOW);
  assert.deepEqual(findWay(g, SELF, RMK.key)?.slice(2, 5), [MIR.key, WAN.key, SKK.key]);
  // An hour later it is worth another try.
  const later = buildGraph(book, state, NOW + 2 * HOUR);
  assert.deepEqual(findWay(later, SELF, RMK.key)?.slice(2, 4), [MIR.key, MRK.key]);
});

test("a way that stayed silent is doubted, not dropped: the next goes round it, or through it when nothing else is left", () => {
  const g = buildGraph(city(), state, NOW);
  const doubt = new Map([[linkId(MIR.key, MRK.key), 0.1]]);
  assert.deepEqual(findWay(g, SELF, RMK.key, { doubt })?.slice(2, 5), [MIR.key, WAN.key, SKK.key]);
  // AMUR-21 is the only way into RMK-3: doubted, it is still the way.
  const only = new Map([[linkId(AMUR.key, RMK.key), 0.09]]);
  assert.deepEqual(findWay(g, SELF, RMK.key, { doubt: only })?.slice(-2), [AMUR.key, RMK.key]);
});

test("a way home is the way out unless the book knows it worse going home", () => {
  const book = city();
  let way = planWay(buildGraph(book, state, NOW), RMK.key, true);
  assert.deepEqual(way, { out: [K10.key, MIR.key, MRK.key, AMUR.key, RMK.key], back: null });
  // Marksa barely hears MIR; home goes round by SKK and Wan7.
  noteLeg(book, "21", "58", 6, NOW);
  noteLeg(book, "58", "21", -14, NOW);
  way = planWay(buildGraph(book, state, NOW), RMK.key, true);
  assert.deepEqual(way?.out, [K10.key, MIR.key, MRK.key, AMUR.key, RMK.key]);
  assert.deepEqual(way?.back, [AMUR.key, MRK.key, SKK.key, WAN.key, MIR.key, K10.key]);
});

test("a way to a person turns at the repeater that hears them", () => {
  const book = city();
  noteFlood(book, [h(AMUR), h(MRK), h(MIR), h(K10)], 5, KOLYA.key, NOW);
  const way = planWay(buildGraph(book, state, NOW), KOLYA.key, false);
  assert.deepEqual(way, { out: [K10.key, MIR.key, MRK.key, AMUR.key], back: null });
});

test("a trace's SNRs are the legs it went along, ours last", () => {
  assert.deepEqual(tracedLegs(["3f", "a1", "3f"], [2, -1, 0.5, 7]), [
    { from: SELF, to: "3f", snr: 2 },
    { from: "3f", to: "a1", snr: -1 },
    { from: "a1", to: "3f", snr: 0.5 },
    { from: "3f", to: SELF, snr: 7 },
  ]);
});

test("the break is found by halving the chain", async () => {
  const probed: number[] = [];
  const at = await locateBreak(7, async (m) => {
    probed.push(m);
    return m <= 4;
  });
  assert.equal(at, 4);
  assert.deepEqual(probed, [3, 5, 4]);
  assert.equal(await locateBreak(1, async () => true), 0);
});

test("a link heard lately counts for more than one heard days ago", () => {
  const book: LinkBook = new Map();
  noteFlood(book, ["3f"], 5, null, NOW);
  const fresh = linkChance(book.get("3f>self")!, NOW);
  const stale = linkChance(book.get("3f>self")!, NOW + 4 * 24 * HOUR);
  assert.ok(fresh > stale && stale > 0);
});

test("the book survives being written out and read back", () => {
  const book = city();
  noteLost(book, "21", "58", NOW);
  const again = bookFromJson(JSON.parse(JSON.stringify(bookToJson(book))));
  assert.deepEqual([...again.entries()], [...book.entries()]);
  assert.equal(bookFromJson("junk").size, 0);
});
