import { test } from "node:test";
import assert from "node:assert/strict";
import { lineOfSight, quality, traceAirtimeMs, type LinkRadio } from "./los.js";

const PKIO: LinkRadio = { frequencyKhz: 869_161, bandwidthHz: 62_500, spreadingFactor: 7, codingRate: 7, txPowerDbm: 22 };

const flat = (km: number, height = 0) => ({ distanceM: km * 1000, elevations: Array.from({ length: 101 }, () => height) });

test("masts well above flat ground see each other with the Fresnel zone clear", () => {
  const los = lineOfSight(flat(10), 40, 40, PKIO);
  assert.equal(los.verdict, "clear");
  assert.equal(los.terrainDb, 0);
  // The Earth bulges about a metre and a half at the middle of 10 km.
  assert.ok(Math.abs(los.bulgeM - 1.47) < 0.02);
});

test("low antennas over flat ground see each other, but the ground reaches into the zone", () => {
  const los = lineOfSight(flat(10), 10, 10, PKIO);
  assert.equal(los.verdict, "grazed");
  assert.ok(los.terrainDb > 0 && los.terrainDb < 6);
  assert.ok(los.worst.clearanceM > 0);
});

test("a hill higher than the line blocks it, and costs more than a graze", () => {
  const profile = flat(10);
  for (let i = 45; i <= 55; i++) profile.elevations[i] = 30;
  const los = lineOfSight(profile, 10, 10, PKIO);
  assert.equal(los.verdict, "blocked");
  assert.ok(los.worst.clearanceM < 0);
  assert.ok(los.terrainDb > 10);
});

test("the ground next to an antenna is not counted: it is the yard the antenna stands in", () => {
  const profile = flat(10);
  profile.elevations[1] = 50;
  assert.equal(lineOfSight(profile, 40, 40, PKIO).verdict, "clear");
});

test("the budget on paper follows free space: 22 dBm and two 2 dBi antennas over 10 km at 869 MHz arrive near −85 dBm", () => {
  const los = lineOfSight(flat(10), 40, 40, PKIO);
  assert.ok(Math.abs(los.freeSpaceDb - 111.2) < 0.2);
  assert.ok(Math.abs(los.arrivesDbm - -85.2) < 0.2);
  // SF7 at 62.5 kHz decodes down to about −127.5 dBm.
  assert.ok(Math.abs(los.limitDbm - -127.5) < 0.1);
});

test("one word per link: good from 0 dB, fair to −5, weak below", () => {
  assert.deepEqual([quality(3), quality(0), quality(-2.5), quality(-5), quality(-6.75)], ["good", "good", "fair", "fair", "weak"]);
});

test("a trace to a repeater two hops out and back takes about 0.7 s of air on the test radio", () => {
  assert.ok(Math.abs(traceAirtimeMs(2, 1, PKIO) - 677) < 2);
});
