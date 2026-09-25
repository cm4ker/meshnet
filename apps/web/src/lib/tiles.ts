/**
 * OpenStreetMap tiles, kept on the device as they are seen. A radio is often
 * used where there is no network, so every tile the map has shown is stored in
 * IndexedDB and served from there; the network is asked only for a tile that
 * is missing or a month old, and a stale tile is still drawn when the network
 * does not answer. Nothing is fetched ahead: OSM's tile policy forbids bulk
 * downloads, so what is cached is what was looked at.
 */

import { t } from "../i18n/index.js";

const DB_NAME = "meshnet-tiles";
const STORE = "tiles";
/** About 80 MB at the ~20 KB an OSM tile weighs. */
const LIMIT = 4000;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
/** The credit OSM asks for, as HTML, in the language of the moment. */
export function tileAttribution(): string {
  return t("mesh.map.attribution", { osm: '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' });
}

interface StoredTile {
  key: string;
  at: number;
  type: string;
  bytes: ArrayBuffer;
}

let database: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: "key" });
      store.createIndex("at", "at");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function read(key: string): Promise<StoredTile | undefined> {
  const db = await open();
  return done(db.transaction(STORE).objectStore(STORE).get(key) as IDBRequest<StoredTile | undefined>);
}

let writes = 0;

async function write(tile: StoredTile): Promise<void> {
  const db = await open();
  await done(db.transaction(STORE, "readwrite").objectStore(STORE).put(tile));
  // Counting on every write would cost more than the tiles; every hundredth is enough.
  if (++writes % 100 === 0) await prune(db);
}

/** Drops the tiles fetched longest ago once there are more than the limit. */
async function prune(db: IDBDatabase): Promise<void> {
  const store = db.transaction(STORE, "readwrite").objectStore(STORE);
  const count = await done(store.count());
  let excess = count - Math.floor(LIMIT * 0.9);
  if (count <= LIMIT || excess <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const cursor = store.index("at").openCursor();
    cursor.onsuccess = () => {
      const at = cursor.result;
      if (!at || excess-- <= 0) return resolve();
      at.delete();
      at.continue();
    };
    cursor.onerror = () => reject(cursor.error);
  });
}

/**
 * The tile at `url`, from the device when it has a fresh copy, else from the
 * network, which refreshes the copy. A copy of any age beats no tile when the
 * network is out.
 */
export async function tileBlob(url: string): Promise<Blob> {
  const cached = await read(url).catch(() => undefined);
  // Not rewritten when read: a zoom reads dozens of tiles, and writing each
  // back only to move its date made every one of them a database write. The
  // pruning goes by when a tile was fetched, which a month's refresh renews.
  if (cached && Date.now() - cached.at < MAX_AGE_MS) return new Blob([cached.bytes], { type: cached.type });
  try {
    const response = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!response.ok) throw new Error(`tile answered ${response.status}`);
    const bytes = await response.arrayBuffer();
    const type = response.headers.get("content-type") ?? "image/png";
    void write({ key: url, at: Date.now(), type, bytes }).catch(() => undefined);
    return new Blob([bytes], { type });
  } catch (error) {
    if (cached) return new Blob([cached.bytes], { type: cached.type });
    throw error;
  }
}
