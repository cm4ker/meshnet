import { test } from "node:test";
import assert from "node:assert/strict";
import { batteryPercent, trailingEmoji } from "./format.js";

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
