import { test } from "node:test";
import assert from "node:assert/strict";
import { fromHex, toHex } from "./bytes.js";
import { channelHash, groupTextPayload } from "./group.js";

// The Public channel's well-known secret, and a message a T-Echo on firmware
// v1.17.1 sent on it on 2026-09-21; the payload is what its repeaters echoed.
const PUBLIC = fromHex("8b3387e9c5cdea6ac9e5edbaa115cd72");

test("a channel message is built byte for byte as the firmware builds it", async () => {
  const payload = await groupTextPayload(PUBLIC, 1789981332, "PKIO Companion", "Работаем!");
  assert.equal(
    toHex(payload),
    "11d6dc2c479b3854d1d8b3808da05c1d141c4d152dd08b762da12b88d12d4e7620586110eff7c0e0c6b788ec71a11ebbba2c92",
  );
});

test("the channel hash is the first byte of SHA-256 of the secret", async () => {
  assert.equal(await channelHash(PUBLIC), 0x11);
});

test("the text is cut so that name, colon and text fit MAX_TEXT_LEN", async () => {
  const long = await groupTextPayload(PUBLIC, 1, "Me", "x".repeat(200));
  const exact = await groupTextPayload(PUBLIC, 1, "Me", "x".repeat(156));
  assert.equal(toHex(long), toHex(exact));
});
