/**
 * Where history lives: IndexedDB, one record per radio, holding the session's
 * persisted state whole. Messages on a mesh are short and few — thousands, not
 * millions — so one document read at connect and written on a debounce is
 * simpler than a schema, and just as fast.
 *
 * Settings that are not per-radio (the remembered link, the theme) are in
 * `localStorage`, read synchronously before the first paint.
 */

import type { PersistedState, SessionStorage } from "@meshnet/meshcore";

const DB_NAME = "meshnet";
const STORE = "radios";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("could not open the database"));
  });
}

function run<T>(db: IDBDatabase, mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = op(tx.objectStore(STORE));
    // A successful request can still be rolled back. Installation must wait for the commit.
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(tx.error ?? request.error ?? new Error("database transaction aborted"));
    tx.onerror = () => reject(tx.error ?? request.error ?? new Error("database transaction failed"));
  });
}

export class IndexedDbStorage implements SessionStorage {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    this.db ??= openDb();
    return this.db;
  }

  async load(radioKey: string): Promise<PersistedState | null> {
    try {
      const db = await this.open();
      const value = await run<PersistedState | undefined>(db, "readonly", (s) => s.get(radioKey));
      return value ?? null;
    } catch (error) {
      console.warn("history could not be read", error);
      return null;
    }
  }

  async save(radioKey: string, state: PersistedState): Promise<void> {
    const db = await this.open();
    await run(db, "readwrite", (s) => s.put(state, radioKey));
  }

  async forget(radioKey: string): Promise<void> {
    const db = await this.open();
    await run(db, "readwrite", (s) => s.delete(radioKey));
  }

  async listRadios(): Promise<string[]> {
    const db = await this.open();
    const keys = await run<IDBValidKey[]>(db, "readonly", (s) => s.getAllKeys());
    return keys.map(String);
  }
}

/** A `localStorage` slot with a JSON value, tolerant of private windows. */
export function readSetting<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeSetting<T>(key: string, value: T | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private window: the setting lives for this page only.
  }
}
