/**
 * Line of sight between two antennas over the ground between them: whether
 * the straight line and the Fresnel zone around it clear the terrain once the
 * Earth's curve is allowed for, and what reaches the far end on paper. The
 * ground comes from a digital elevation model, which knows hills and not
 * houses or trees, so this says what the terrain allows and no more.
 */

import { airtimeMs } from "./composer.js";

/** Refraction bends a radio path a little round the Earth: it sees a planet 4/3 the size. */
const K_FACTOR = 4 / 3;
const EARTH_M = 6_371_000;
/** Next to an antenna the elevation model measures the yard it stands in, not the path. */
const NEAR_M = 250;
/**
 * How far the model may be off, m: a few metres either way, more where it
 * caught a roof. Ground within this of the line is not taken for a hill.
 */
const MODEL_SLACK_M = 3;

/** The ground from one end to the other, sampled at even steps; both ends included. */
export interface Profile {
  distanceM: number;
  elevations: number[];
}

/** What the radios at both ends do: power, antennas, and the LoRa settings that decide what can be heard. */
export interface LinkRadio {
  frequencyKhz: number;
  bandwidthHz: number;
  spreadingFactor: number;
  codingRate: number;
  txPowerDbm: number;
  /** Each antenna, dBi. */
  antennaGainDbi?: number;
  /** The receiver's own noise, dB. */
  noiseFigureDb?: number;
}

export type Verdict = "clear" | "grazed" | "blocked";

export interface ProfilePoint {
  /** From the first end, m. */
  d: number;
  /** The ground, raised by the Earth's curve so the line of sight can be drawn straight, m. */
  ground: number;
  /** The line between the antennas, m. */
  line: number;
  /** The first Fresnel zone's radius here, m. */
  fresnel: number;
  /** Too close to an end to count. */
  near: boolean;
}

export interface LineOfSight {
  points: ProfilePoint[];
  /**
 * The point where the ground comes closest to the line: its clearance, and
 * as a share of the Fresnel radius, allowing for the model's error; below 0
 * the ground cuts the line.
 */
  worst: { index: number; d: number; clearanceM: number; ratio: number };
  verdict: Verdict;
  /** Lost to the ground in the way, by the single knife-edge model; optimistic for a broad hill. */
  terrainDb: number;
  freeSpaceDb: number;
  /** What arrives, on paper, dBm. */
  arrivesDbm: number;
  /** The weakest signal the far end can still decode, dBm. */
  limitDbm: number;
  marginDb: number;
  /** How far the Earth bulges up at the middle, m. */
  bulgeM: number;
}

/** The lowest SNR each spreading factor still decodes, dB (Semtech's tables). */
const SNR_LIMIT: Record<number, number> = { 5: -2.5, 6: -5, 7: -7.5, 8: -10, 9: -12.5, 10: -15, 11: -17.5, 12: -20 };

export function snrLimit(spreadingFactor: number): number {
  return SNR_LIMIT[spreadingFactor] ?? -7.5;
}

/** One word for how a link sounds: at least 0 dB is good, down to −5 dB fair, below that weak. */
export type Quality = "good" | "fair" | "weak";

export function quality(snr: number): Quality {
  return snr >= 0 ? "good" : snr >= -5 ? "fair" : "weak";
}

export const QUALITY_WORDS: Record<Quality, string> = { good: "Good", fair: "Fair", weak: "Weak" };

export const VERDICT_WORDS: Record<Verdict, string> = { clear: "Clear view", grazed: "Fresnel zone grazed", blocked: "Blocked by terrain" };

/**
 * The line of sight between antennas `heightA` and `heightB` metres above the
 * ground at the two ends of `profile`. Clear when the line and 60 % of the
 * first Fresnel zone pass above the ground all the way; grazed when the line
 * does but the zone does not; blocked when the ground rises above the line.
 */
export function lineOfSight(profile: Profile, heightA: number, heightB: number, radio: LinkRadio): LineOfSight {
  const e = profile.elevations;
  const n = e.length;
  if (n < 2) throw new Error("a profile needs both ends");
  const D = profile.distanceM;
  const ghz = radio.frequencyKhz / 1_000_000;
  const a = e[0]! + heightA;
  const b = e[n - 1]! + heightB;
  const points = e.map((z, i) => {
    const t = i / (n - 1);
    const d1 = D * t;
    const d2 = D - d1;
    const bulge = (d1 * d2) / (2 * K_FACTOR * EARTH_M);
    const fresnel = d1 > 0 && d2 > 0 ? 17.32 * Math.sqrt(((d1 / 1000) * (d2 / 1000)) / (ghz * (D / 1000))) : 0;
    return { d: d1, ground: z + bulge, line: a + (b - a) * t, fresnel, near: d1 < NEAR_M || d2 < NEAR_M };
  });
  let worst: LineOfSight["worst"] | null = null;
  points.forEach((p, index) => {
    if (p.near || p.fresnel === 0) return;
    const clearanceM = p.line - p.ground;
    const ratio = (clearanceM + MODEL_SLACK_M) / p.fresnel;
    if (!worst || ratio < worst.ratio) worst = { index, d: p.d, clearanceM, ratio };
  });
  // A hop so short that every point is next to an end: nothing in between to be in the way.
  const w: LineOfSight["worst"] = worst ?? { index: Math.floor(n / 2), d: D / 2, clearanceM: Infinity, ratio: Infinity };
  // Fresnel–Kirchhoff's v for the worst point, and Lee's fit of the knife-edge loss (ITU-R P.526).
  const v = -Math.SQRT2 * w.ratio;
  const terrainDb = v > -0.78 ? 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1) : 0;
  const freeSpaceDb = 20 * Math.log10(Math.max(D, 1) / 1000) + 20 * Math.log10(radio.frequencyKhz / 1000) + 32.44;
  const gain = radio.antennaGainDbi ?? 2;
  const arrivesDbm = radio.txPowerDbm + 2 * gain - freeSpaceDb - terrainDb;
  const limitDbm = -174 + 10 * Math.log10(radio.bandwidthHz) + (radio.noiseFigureDb ?? 6) + snrLimit(radio.spreadingFactor);
  const verdict: Verdict = w.ratio >= 0.6 ? "clear" : w.ratio >= 0 ? "grazed" : "blocked";
  return { points, worst: w, verdict, terrainDb, freeSpaceDb, arrivesDbm, limitDbm, marginDb: arrivesDbm - limitDbm, bulgeM: (D / 2) ** 2 / (2 * K_FACTOR * EARTH_M) };
}

/**
 * Time on the air of one trace out along `relays` hops and back: it is sent
 * once and repeated by every hop, and grows by a byte at each, the SNR the
 * hop adds. The payload is the tag, the code, the flags and the path.
 */
export function traceAirtimeMs(relays: number, hashSize: number, radio: Pick<LinkRadio, "spreadingFactor" | "bandwidthHz" | "codingRate">): number {
  const hashes = 2 * relays - 1;
  const payload = 9 + hashes * hashSize;
  let total = 0;
  for (let i = 0; i <= hashes; i++) total += airtimeMs(2 + i + payload, radio);
  return total;
}

/** An SNR as the tools show it: signed, to the quarter dB the radio measures. */
export function formatSnr(snr: number): string {
  const text = Math.abs(snr).toFixed(2).replace(/0$/, "");
  return `${snr > 0 ? "+" : snr < 0 ? "−" : ""}${text}`;
}

/** A power in dBm with a real minus sign. */
export function formatDbm(dbm: number): string {
  return `${Math.round(dbm)}`.replace("-", "−") + " dBm";
}
