import { test } from "node:test";
import assert from "node:assert/strict";
import type { LppReading, SeriesSummary } from "@meshnet/meshcore";
import { batteryPercent, powerSummary, powerWatts, trailingEmoji } from "./format.js";

test("the emoji a name ends with goes on its circle", () => {
  assert.equal(trailingEmoji("Fox 🦊"), "🦊");
  assert.equal(trailingEmoji("Kolya ⛺ "), "⛺");
  assert.equal(trailingEmoji("Base 🇩🇪"), "🇩🇪");
  assert.equal(trailingEmoji("Dad 👨‍👩‍👧"), "👨‍👩‍👧");
  assert.equal(trailingEmoji("Love ❤️"), "❤️");
});

test("a name ending in a letter, a digit or a text symbol has no emoji", () => {
  assert.equal(trailingEmoji("Anna"), null);
  assert.equal(trailingEmoji("🦊 Fox"), null);
  assert.equal(trailingEmoji("Node-21"), null);
  assert.equal(trailingEmoji("Acme ©"), null);
  assert.equal(trailingEmoji(""), null);
});

test("a LiFePO4 cell near full reads near full, not nearly empty (#26)", () => {
  assert.equal(batteryPercent(3350, "lifepo4"), 90);
  assert.equal(batteryPercent(3350), 8);
  assert.equal(batteryPercent(3650, "lifepo4"), 100);
  assert.equal(batteryPercent(3200, "lifepo4"), 20);
});

test("a charge is read off the curve, straight between its points, and kept within 0 to 100", () => {
  assert.equal(batteryPercent(3890), 70);
  assert.equal(batteryPercent(3940), 75);
  assert.equal(batteryPercent(4200), 100);
  assert.equal(batteryPercent(3100), 0);
  assert.equal(batteryPercent(2800), 0);
  assert.equal(batteryPercent(2500, "lifepo4"), 0);
});

test("power comes from the channel's voltage and current, not the whole watts it is sent in", () => {
  const readings: LppReading[] = [
    { channel: 4, type: "voltage", volts: 3.38 },
    { channel: 4, type: "current", amps: 0.119 },
    { channel: 4, type: "power", watts: 0 },
    { channel: 5, type: "power", watts: 2 },
  ];
  assert.equal(Math.round(powerWatts({ channel: 4, watts: 0 }, readings) * 1000), 402);
  // Without both on its channel, what was sent stands.
  assert.equal(powerWatts({ channel: 5, watts: 2 }, readings), 2);
});

test("a power series comes from the channel's voltage and current series", () => {
  const series: SeriesSummary[] = [
    { channel: 4, lppType: 0x74, min: 3.3, max: 3.4, avg: 3.38 },
    { channel: 4, lppType: 0x75, min: 0.1, max: 0.13, avg: 0.119 },
    { channel: 4, lppType: 0x80, min: 0, max: 0, avg: 0 },
    { channel: 5, lppType: 0x80, min: 1, max: 3, avg: 2 },
  ];
  const mw = (w: number) => Math.round(w * 1000);
  const power = powerSummary(series[2]!, series);
  assert.deepEqual([mw(power.min), mw(power.avg), mw(power.max)], [330, 402, 442]);
  assert.deepEqual(powerSummary(series[3]!, series), series[3]);
});
