import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { hashtagName, hashtagSecret } from "./channels.js";

test("a public channel's name keeps one leading # and folds case and spaces", () => {
  assert.equal(hashtagName("Berlin"), "#berlin");
  assert.equal(hashtagName("  ##Test "), "#test");
  assert.equal(hashtagName("#Москва"), "#москва");
  assert.equal(hashtagName("#"), null);
});

test("a public channel's key is the first half of SHA-256 of its name, # included", async () => {
  const expected = createHash("sha256").update("#test", "utf8").digest("hex").slice(0, 32);
  assert.equal(await hashtagSecret("#test"), expected);
});
