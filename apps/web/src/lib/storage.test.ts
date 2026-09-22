import { test } from "node:test";
import assert from "node:assert/strict";
import type { PersistedState } from "@meshnet/meshcore";
import { IndexedDbStorage } from "./storage.js";

/** A stand-in for IndexedDB: every transaction is handed to the test to complete or abort. */
function fakeIndexedDb(t: { after: (fn: () => void) => void }, result: unknown = "radio") {
  const transactions: IDBTransaction[] = [];
  let opens = 0;
  const request = { result, error: null };
  const store = { put: () => request, get: () => request };
  const db = {
    version: 1,
    objectStoreNames: { contains: () => true },
    close: () => undefined,
    transaction: () => {
      const tx = { error: null, objectStore: () => store } as unknown as IDBTransaction;
      transactions.push(tx);
      return tx;
    },
  };
  const old = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open: () => {
        opens++;
        const opening = { result: db, onsuccess: () => {} };
        queueMicrotask(() => opening.onsuccess());
        return opening;
      },
    },
  });
  t.after(() => {
    if (old) Object.defineProperty(globalThis, "indexedDB", old);
    else Reflect.deleteProperty(globalThis, "indexedDB");
  });
  return { transactions, opens: () => opens };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("history save waits for transaction commit, tries a rolled-back one once more, then rejects", async (t) => {
  const idb = fakeIndexedDb(t);
  const storage = new IndexedDbStorage();
  let saved = false;
  const saving = storage.save("radio", {} as PersistedState).then(() => {
    saved = true;
  });
  await settle();
  assert.equal(saved, false);
  idb.transactions.at(-1)!.oncomplete!(new Event("complete"));
  await saving;
  assert.equal(saved, true);

  const rollback = storage.save("radio", {} as PersistedState);
  const rejected = assert.rejects(rollback, /aborted/);
  await settle();
  idb.transactions.at(-1)!.onabort!(new Event("abort"));
  // The second try goes over a new connection.
  await settle();
  assert.equal(idb.opens(), 2);
  idb.transactions.at(-1)!.onabort!(new Event("abort"));
  await rejected;
});

test("a history that cannot be read rejects, rather than reading as none", async (t) => {
  const idb = fakeIndexedDb(t);
  const storage = new IndexedDbStorage();
  const loading = assert.rejects(storage.load("radio"), /aborted/);
  await settle();
  idb.transactions.at(-1)!.onabort!(new Event("abort"));
  await settle();
  idb.transactions.at(-1)!.onabort!(new Event("abort"));
  await loading;
});

test("a read that fails on a lost connection succeeds on a new one", async (t) => {
  const idb = fakeIndexedDb(t, { messages: [] });
  const storage = new IndexedDbStorage();
  const loading = storage.load("radio");
  await settle();
  idb.transactions.at(-1)!.onerror!(new Event("error"));
  await settle();
  idb.transactions.at(-1)!.oncomplete!(new Event("complete"));
  assert.deepEqual(await loading, { messages: [] });
  assert.equal(idb.opens(), 2);
});
