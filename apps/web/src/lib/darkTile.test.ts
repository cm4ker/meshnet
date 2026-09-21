import { test } from "node:test";
import assert from "node:assert/strict";
import { darkenPixels } from "./darkTile.js";

const px = (...rgb: number[]) => new Uint8ClampedArray([...rgb, 255]);

test("white land turns dark and black text turns light", () => {
  const land = px(242, 239, 233);
  darkenPixels(land);
  assert.ok(land[0]! < 50 && land[1]! < 50 && land[2]! < 50, `land ${[...land]}`);
  const text = px(0, 0, 0);
  darkenPixels(text);
  assert.ok(text[0]! > 180 && text[1]! > 180 && text[2]! > 180, `text ${[...text]}`);
});

test("water stays blue and alpha is left alone", () => {
  const water = new Uint8ClampedArray([170, 211, 223, 128]);
  darkenPixels(water);
  assert.ok(water[2]! > water[0]!, `water ${[...water]}`);
  assert.equal(water[3], 128);
});
