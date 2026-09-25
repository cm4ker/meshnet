/**
 * The height of the ground anywhere, from Mapzen's terrain tiles on AWS Open
 * Data ("Terrarium": metres packed into a PNG's colours). They are kept on
 * the device with the map's own tiles (lib/tiles.ts), so a line of sight
 * looked at once opens again where there is no network. Around St Petersburg
 * the tiles are made from ArcticDEM (5 m) and SRTM; everywhere they are a
 * surface that knows hills, not houses or trees.
 */

import { t } from "../i18n/index.js";
import type { Profile } from "./los.js";
import { tileBlob } from "./tiles.js";

const URL_OF = (z: number, x: number, y: number) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
/** About 20 m a pixel at 60° north: finer than the model under it, and a 30 km line needs a handful of tiles. */
const ZOOM = 12;
const SIZE = 256;
/** Decoded tiles kept in memory: a quarter of a megabyte each. */
const KEEP = 48;

/** The credit for the terrain, in the language of the moment. */
export function elevationAttribution(): string {
  return t("mesh.terrainAttribution");
}

const decoded = new Map<string, Promise<Float32Array>>();

async function heights(blob: Blob): Promise<Float32Array> {
  const image = await createImageBitmap(blob);
  const canvas = typeof OffscreenCanvas === "function" ? new OffscreenCanvas(SIZE, SIZE) : Object.assign(document.createElement("canvas"), { width: SIZE, height: SIZE });
  const context = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!context) throw new Error("no canvas to read the terrain with");
  context.drawImage(image, 0, 0);
  image.close();
  const { data } = context.getImageData(0, 0, SIZE, SIZE);
  const out = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < out.length; i++) out[i] = data[i * 4]! * 256 + data[i * 4 + 1]! + data[i * 4 + 2]! / 256 - 32768;
  return out;
}

function tile(x: number, y: number): Promise<Float32Array> {
  const key = `${x}/${y}`;
  let found = decoded.get(key);
  if (found) {
    decoded.delete(key);
    decoded.set(key, found);
    return found;
  }
  found = tileBlob(URL_OF(ZOOM, x, y)).then(heights);
  found.catch(() => decoded.delete(key));
  decoded.set(key, found);
  while (decoded.size > KEEP) decoded.delete(decoded.keys().next().value!);
  return found;
}

/** The point in tile pixels at `ZOOM`, Web Mercator. */
function pixel(lat: number, lon: number): { x: number; y: number } {
  const n = 2 ** ZOOM * SIZE;
  const r = (lat * Math.PI) / 180;
  return { x: ((lon + 180) / 360) * n, y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n };
}

async function at(px: number, py: number): Promise<number> {
  const x = Math.floor(px);
  const y = Math.floor(py);
  const read = async (ix: number, iy: number) => {
    const t = await tile(Math.floor(ix / SIZE), Math.floor(iy / SIZE));
    return t[(iy % SIZE) * SIZE + (ix % SIZE)]!;
  };
  const [a, b, c, d] = await Promise.all([read(x, y), read(x + 1, y), read(x, y + 1), read(x + 1, y + 1)]);
  const fx = px - x;
  const fy = py - y;
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

const EARTH_M = 6_371_008.8;

function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The ground from `a` to `b`, sampled every 60 m or so and never fewer than
 * 64 times. Rejects when a tile is neither on the device nor reachable.
 */
export async function profileBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): Promise<Profile> {
  const d = distanceM(a, b);
  const samples = Math.max(64, Math.min(400, Math.ceil(d / 60) + 1));
  const from = pixel(a.lat, a.lon);
  const to = pixel(b.lat, b.lon);
  // Straight in Mercator pixels: at these distances the difference from a great circle is under a pixel.
  const elevations = await Promise.all(
    Array.from({ length: samples }, (_, i) => {
      const t = i / (samples - 1);
      return at(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    }),
  );
  return { distanceM: d, elevations: elevations.map((z) => Math.round(z * 10) / 10) };
}
