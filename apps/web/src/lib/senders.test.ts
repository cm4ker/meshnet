import { test } from "node:test";
import assert from "node:assert/strict";
import type { ContactRecord, MessageRecord } from "@meshnet/meshcore";
import { sendersOf } from "./senders.js";

function contact(key: string, name: string, lastHeardAt: number | null = null): ContactRecord {
  return { key, prefix: key.slice(0, 12), type: 1, flags: 0, outPathLen: 0xff, outPath: "", name, lastAdvert: 0, lat: 0, lon: 0, lastMod: 0, lastHeardAt, pathSince: null };
}

function heard(sender: string | null, senderPrefix: string | null = null): MessageRecord {
  return {
    id: "m",
    conversation: "ch:1",
    direction: "in",
    text: "hi",
    sender,
    senderPrefix,
    timestamp: 0,
    receivedAt: 0,
    snr: null,
    hops: null,
    txtType: 0,
    status: null,
    ackTag: null,
    roundTripMs: null,
    flood: null,
    attempt: 0,
    error: null,
    echoes: [],
    route: null,
    retryPlan: null,
  };
}

const contacts = {
  a: contact("aa" + "00".repeat(31), "Fox 🦊", 1_000),
  b: contact("bb" + "00".repeat(31), "Kite", 2_000),
  c: contact("cc" + "00".repeat(31), "Kite", 9_000),
  d: contact("dd" + "00".repeat(31), "Ridge"),
};

test("a channel message is from every contact of its name, the one heard last first", () => {
  assert.deepEqual(
    sendersOf(heard("Kite"), contacts).map((c) => c.key),
    [contacts.c.key, contacts.b.key],
  );
  assert.deepEqual(
    sendersOf(heard("Fox 🦊"), contacts).map((c) => c.name),
    ["Fox 🦊"],
  );
});

test("a name nobody on the radio has, or none at all, finds no one", () => {
  assert.deepEqual(sendersOf(heard("Bear 🐻"), contacts), []);
  assert.deepEqual(sendersOf(heard("fox 🦊"), contacts), []);
  assert.deepEqual(sendersOf(heard(null), contacts), []);
});

test("a room post finds its author by the key, whatever name it shows", () => {
  assert.deepEqual(
    sendersOf(heard("Someone else", "bb000000"), contacts).map((c) => c.key),
    [contacts.b.key],
  );
  assert.deepEqual(sendersOf(heard("ee000000", "ee000000"), contacts), []);
});
