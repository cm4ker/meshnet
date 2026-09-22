import { test } from "node:test";
import assert from "node:assert/strict";
import { flushDrafts, getDraft, setDraft } from "./drafts.js";

test("installation flushes a pending draft synchronously and surfaces storage failure", (t) => {
  const old = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let fail = false;
  let saved = "";
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    setItem: (_key: string, value: string) => { if (fail) throw new Error("disk full"); saved = value; },
  } });
  t.after(() => { if (old) Object.defineProperty(globalThis, "localStorage", old); else Reflect.deleteProperty(globalThis, "localStorage"); });
  setDraft("radio", "chat", "Unsent text");
  flushDrafts();
  assert.equal(JSON.parse(saved)["radio/chat"], "Unsent text");
  fail = true;
  setDraft("radio", "chat", "Updated text");
  assert.throws(flushDrafts, /disk full/);
  assert.equal(getDraft("radio", "chat"), "Updated text");
  fail = false;
  flushDrafts();
  assert.equal(JSON.parse(saved)["radio/chat"], "Updated text");
  setDraft("radio", "chat", "");
  flushDrafts();
  assert.deepEqual(JSON.parse(saved), {});
});
