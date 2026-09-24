import { test } from "node:test";
import assert from "node:assert/strict";
import type { ContactRecord } from "@meshnet/meshcore";
import { nameOfHash, relaysOf, spreadOf } from "./echoes.js";

function contact(key: string, name: string, type = 2): ContactRecord {
  return { key, prefix: key.slice(0, 12), type, flags: 0, outPathLen: 0xff, outPath: "", name, lastAdvert: 0, lat: 0, lon: 0, lastMod: 0, lastHeardAt: null, pathSince: null };
}

test("relays are the distinct hashes of every path, named when one contact matches", () => {
  const contacts = {
    a: contact("7932" + "00".repeat(30), "Hill"),
    b: contact("ce5b" + "00".repeat(30), "Tower"),
    c: contact("ce5b" + "11".repeat(30), "Tower twin"),
  };
  const relays = relaysOf([{ path: ["7932"], snr: 4 }, { path: ["7932", "ce5b"], snr: -2 }, { path: ["dc0a"], snr: 1 }], contacts);
  assert.deepEqual(relays, [
    { hash: "7932", name: "Hill" },
    { hash: "ce5b", name: null },
    { hash: "dc0a", name: null },
  ]);
});

test("a hash shared by a repeater and a chat is the repeater: only repeaters and rooms relay", () => {
  const contacts = {
    a: contact("a3" + "00".repeat(31), "Kupol"),
    b: contact("a3" + "11".repeat(31), "Vasya", 1),
    c: contact("5e" + "22".repeat(31), "Marina", 1),
  };
  assert.equal(nameOfHash("a3", contacts), "Kupol");
  assert.equal(nameOfHash("5e", contacts), "Marina");
});

test("copies heard back say who heard the sender, loudest first, and how far it went on", () => {
  // As heard back from a message on Public: three repeaters sent it on themselves, and one copy came five relays out.
  const spread = spreadOf([
    { path: ["a5"], snr: 4.75 },
    { path: ["b1"], snr: 12.25 },
    { path: ["c3"], snr: 6.5 },
    { path: ["a5", "10", "58", "ad", "d0"], snr: 1.5 },
  ]);
  assert.deepEqual(spread.first, [
    { hash: "b1", snr: 12.25 },
    { hash: "c3", snr: 6.5 },
    { hash: "a5", snr: 4.75 },
  ]);
  assert.deepEqual(spread.further, ["10", "58", "ad", "d0"]);
  assert.equal(spread.farthest, 5);
  assert.deepEqual(spread.chains, [["a5", "10", "58", "ad", "d0"]]);
});

test("a relay heard only through others still counts among the first, with no loudness of its own", () => {
  const spread = spreadOf([
    { path: ["a5", "10"], snr: 3 },
    { path: ["10"], snr: 7 },
  ]);
  assert.deepEqual(spread.first, [
    { hash: "10", snr: 7 },
    { hash: "a5", snr: null },
  ]);
  assert.deepEqual(spread.further, []);
  assert.equal(spreadOf([]).farthest, 0);
});
