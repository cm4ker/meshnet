import { test } from "node:test";
import assert from "node:assert/strict";
import { packLookalikes } from "./lookalikes.js";
import { utf8Length } from "./format.js";

test("Cyrillic letters with an exact Latin twin go out as the twin, and nothing else changes", () => {
  const text = "Кто слышит из Озерков? Антенна 5 дБи, Tesla и к/т/п";
  const packed = packLookalikes(text, { on: true, near: false });
  assert.equal(packed, "Kтo cлышит из Oзepкoв? Aнтeннa 5 дБи, Tesla и к/т/п");
  assert.equal(utf8Length(text) - utf8Length(packed), 10);
});

test("у and У are swapped only when asked, and nothing is when switched off", () => {
  assert.equal(packLookalikes("Утро у реки", { on: true, near: false }), "Утpo у peки");
  assert.equal(packLookalikes("Утро у реки", { on: true, near: true }), "Yтpo y peки");
  assert.equal(packLookalikes("Утро у реки", { on: false, near: true }), "Утро у реки");
});
