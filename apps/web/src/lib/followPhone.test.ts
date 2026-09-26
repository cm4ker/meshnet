import { test } from "node:test";
import assert from "node:assert/strict";
import { FOLLOW_EVERY_MS, followStep } from "./followPhone.js";

const HOME = { lat: 55.75812, lon: 37.62311 };
/** A spot this many metres due north of home. */
const north = (m: number) => ({ lat: HOME.lat + m / 111_195, lon: HOME.lon });
const fix = (m: number, accuracy: number) => ({ ...north(m), accuracy, at: 0 });
const MIN = 60_000;

test("a walk from home to the river: the radio moves only when it is far enough, often enough, and the fix good enough", () => {
  const start = 18 * 60 * MIN;
  // 18:00, turned on: the radio still sits 1.2 km away, where it was put long ago.
  assert.equal(followStep(fix(0, 6), north(-1200), null, start), "write");
  // 18:01, in the yard, 40 m from the radio.
  assert.equal(followStep(fix(40, 9), HOME, start, start + MIN), "near");
  // 18:03, 260 m on, but only three minutes since the write.
  assert.equal(followStep(fix(260, 7), HOME, start, start + 3 * MIN), "wait");
  // 18:05, 410 m on, five minutes since.
  assert.equal(followStep(fix(410, 8), HOME, start, start + 5 * MIN), "write");
  // 18:11, in an underpass: the fix is 140 m either way.
  assert.equal(followStep(fix(710, 140), north(410), start + 5 * MIN, start + 11 * MIN), "rough");
  // 18:12, out on the embankment.
  assert.equal(followStep(fix(790, 5), north(410), start + 5 * MIN, start + 12 * MIN), "write");
  // Standing there: the fix drifts a few metres.
  assert.equal(followStep(fix(803, 5), north(790), start + 12 * MIN, start + 90 * MIN), "near");
});

test("a radio that has no position yet takes the phone's at once", () => {
  assert.equal(followStep(fix(0, 20), { lat: 0, lon: 0 }, null, 0), "write");
  assert.equal(followStep(fix(0, 20), null, null, 0), "write");
});

test("the limits themselves: 50 m is near, 100 m of doubt is still good, five minutes is long enough", () => {
  assert.equal(followStep(fix(49.9, 100), HOME, null, 0), "near");
  assert.equal(followStep(fix(51, 100), HOME, null, 0), "write");
  assert.equal(followStep(fix(51, 101), HOME, null, 0), "rough");
  assert.equal(followStep(fix(51, 10), HOME, 0, FOLLOW_EVERY_MS - 1), "wait");
  assert.equal(followStep(fix(51, 10), HOME, 0, FOLLOW_EVERY_MS), "write");
});
