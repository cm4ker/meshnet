import { test } from "node:test";
import assert from "node:assert/strict";
import type { ContactRecord, NeighbourList } from "@meshnet/meshcore";
import { contactOfPrefix, heardInList, isComplete, neighbourRows, STALE_S } from "./neighbours.js";

const contact = (key: string, name: string, lat = 0, lon = 0) => ({ key, name, prefix: key.slice(0, 12), type: 2, lat, lon }) as unknown as ContactRecord;

const HILL = "aa".repeat(32);
const TOWER = "bb".repeat(32);
const RIDGE = "cc".repeat(32);
const contacts = { [HILL]: contact(HILL, "Hill", 55, 73), [TOWER]: contact(TOWER, "Tower", 55.1, 73.1), [RIDGE]: contact(RIDGE, "Ridge") };
const AT = 1_000_000_000;
const list = (neighbours: NeighbourList["neighbours"], total = neighbours.length): NeighbourList => ({ total, order: 0, neighbours, at: AT });

test("a neighbour is matched to the contact its prefix names, and placed only with a position", () => {
  const state = { contacts, neighbours: { [HILL]: list([{ prefix: TOWER.slice(0, 12), heardSecsAgo: 60, snr: 4 }, { prefix: RIDGE.slice(0, 12), heardSecsAgo: 60, snr: 8 }, { prefix: "0d4c7bddeeff", heardSecsAgo: 60, snr: -3 }]) } };
  const rows = neighbourRows(state, HILL, AT);
  assert.deepEqual(rows.map((r) => [r.contact?.name ?? r.prefix, r.placed]), [["Ridge", false], ["Tower", true], ["0d4c7bddeeff", false]]);
});

test("how long ago a neighbour was heard counts from now, and past a day it may be gone", () => {
  const state = { contacts, neighbours: { [HILL]: list([{ prefix: TOWER.slice(0, 12), heardSecsAgo: STALE_S - 600, snr: 1 }]) } };
  assert.equal(neighbourRows(state, HILL, AT)[0]!.stale, false);
  const later = neighbourRows(state, HILL, AT + 3_600_000)[0]!;
  assert.equal(later.heardS, STALE_S + 3000);
  assert.equal(later.stale, true);
});

test("the other way round is known only from the neighbour's own list", () => {
  const state = { neighbours: { [TOWER]: list([{ prefix: HILL.slice(0, 12), heardSecsAgo: 30, snr: -1.5 }]) } };
  assert.deepEqual(heardInList(state, TOWER, HILL, AT + 10_000), { snr: -1.5, heardS: 40 });
  assert.equal(heardInList(state, HILL, TOWER, AT), null);
});

test("a list is complete once it holds as many as the repeater said", () => {
  assert.equal(isComplete(undefined), false);
  assert.equal(isComplete(list([{ prefix: "01", heardSecsAgo: 1, snr: 0 }], 12)), false);
  assert.equal(isComplete(list([], 0)), true);
});

test("an empty prefix names nobody", () => {
  assert.equal(contactOfPrefix(contacts, ""), null);
  assert.equal(contactOfPrefix(contacts, TOWER.slice(0, 12))?.name, "Tower");
});
