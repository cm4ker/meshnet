import { test } from "node:test";
import assert from "node:assert/strict";
import { AdvType } from "@meshnet/meshcore";
import { bearingDeg, compass, distanceKm, formatDistance, freshness, hasPosition } from "./geo.js";

test("0, 0 is no position, and so is anything off the globe", () => {
  assert.equal(hasPosition(0, 0), false);
  assert.equal(hasPosition(43.2381, 76.9452), true);
  assert.equal(hasPosition(0, 12), true);
  assert.equal(hasPosition(91, 10), false);
});

test("a degree of latitude is about 111 km, and due north is 0°", () => {
  assert.ok(Math.abs(distanceKm(43, 77, 44, 77) - 111.2) < 0.2);
  assert.ok(Math.abs(bearingDeg(43, 77, 44, 77)) < 0.01);
  assert.equal(compass(bearingDeg(43, 77, 43, 78)), "E");
  assert.equal(compass(bearingDeg(43, 77, 42.9, 76.9)), "SW");
});

test("short distances read in metres, long ones without decimals", () => {
  assert.equal(formatDistance(0.579), "579 m");
  assert.equal(formatDistance(6.44), "6.4 km");
  assert.equal(formatDistance(312.4), "312 km");
});

test("a repeater stays fresh for hours, a person for an hour", () => {
  assert.equal(freshness(AdvType.Chat, 30 * 60), "fresh");
  assert.equal(freshness(AdvType.Chat, 3 * 3600), "aging");
  assert.equal(freshness(AdvType.Chat, 2 * 86400), "stale");
  assert.equal(freshness(AdvType.Repeater, 3 * 3600), "fresh");
  assert.equal(freshness(AdvType.Repeater, 30 * 3600), "aging");
});
