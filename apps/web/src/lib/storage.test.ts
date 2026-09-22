import { test } from "node:test";
import assert from "node:assert/strict";
import type { PersistedState } from "@meshnet/meshcore";
import { IndexedDbStorage } from "./storage.js";

test("history save waits for transaction commit and rejects rollback after a successful request", async (t) => {
  let tx: IDBTransaction;
  const request = { result: "radio", error: null };
  const db = { transaction: () => (tx = { error: null, objectStore: () => ({ put: () => request }) } as unknown as IDBTransaction) };
  const old = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: { open: () => {
    const opening = { result: db, onsuccess: () => {} };
    queueMicrotask(() => opening.onsuccess());
    return opening;
  } } });
  t.after(() => { if (old) Object.defineProperty(globalThis, "indexedDB", old); else Reflect.deleteProperty(globalThis, "indexedDB"); });
  const storage = new IndexedDbStorage();
  let saved = false;
  const saving = storage.save("radio", {} as PersistedState).then(() => { saved = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saved, false);
  tx!.oncomplete!(new Event("complete"));
  await saving;
  assert.equal(saved, true);

  const rollback = storage.save("radio", {} as PersistedState);
  const rejected = assert.rejects(rollback, /aborted/);
  await new Promise((resolve) => setImmediate(resolve));
  tx!.onabort!(new Event("abort"));
  await rejected;
});
