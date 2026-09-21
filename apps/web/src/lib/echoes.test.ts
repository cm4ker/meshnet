import { test } from "node:test";
import assert from "node:assert/strict";
import type { ContactRecord } from "@meshnet/meshcore";
import { relaysOf } from "./echoes.js";

function contact(key: string, name: string): ContactRecord {
  return { key, prefix: key.slice(0, 12), type: 2, flags: 0, outPathLen: 0xff, outPath: "", name, lastAdvert: 0, lat: 0, lon: 0, lastMod: 0, lastHeardAt: null };
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
